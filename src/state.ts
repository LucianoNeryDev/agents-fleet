import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { stateFilePath } from "./paths.js"
import type { ActivationState, LoadedConfig } from "./types.js"
import { assertID } from "./validation.js"
import { requireFleet } from "./loader.js"

export function parseState(text: string, source = "agents-fleet state"): ActivationState {
  let value: unknown
  try { value = JSON.parse(text) } catch (error) { throw new Error(`Invalid ${source}: malformed JSON (${error instanceof Error ? error.message : String(error)})`) }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${source}: expected version 1 state`)
  const item = value as Record<string, unknown>
  if (Object.keys(item).sort().join(",") !== "fleet,fleetActivatedAt,version") throw new Error(`Invalid ${source}: unsupported fields; expected a version 1 state with fleet and fleetActivatedAt`)
  if (item.version !== 1 || typeof item.fleet !== "string" || typeof item.fleetActivatedAt !== "number" || !Number.isSafeInteger(item.fleetActivatedAt) || (item.fleetActivatedAt as number) < 0) throw new Error(`Invalid ${source}: expected version 1 fleet state`)
  assertID(item.fleet, "State fleet")
  return item as ActivationState
}

export async function loadState(path = stateFilePath()): Promise<ActivationState | undefined> {
  try { return parseState(await readFile(path, "utf8"), path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
}

export async function selectState(config: LoadedConfig, path = stateFilePath()): Promise<ActivationState> {
  const stored = await loadState(path)
  if (stored) {
    if (!config.fleets.has(stored.fleet)) throw new Error(`Persisted fleet "${stored.fleet}" is not present in configuration`)
    return stored
  }
  return { version: 1, fleet: [...config.fleets.keys()].sort()[0], fleetActivatedAt: 0 }
}

async function atomicWrite(path: string, value: ActivationState): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  try {
    const file = await open(temporary, "wx", 0o600)
    try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await file.sync() } finally { await file.close() }
    await rename(temporary, path)
    try { const dir = await open(directory, "r"); try { await dir.sync() } finally { await dir.close() } } catch { /* fsync is not portable */ }
  } catch (error) { await rm(temporary, { force: true }); throw error }
}

/** An unreadable prior state is replaced by an explicit selection, not preserved. */
async function currentState(path: string): Promise<ActivationState | undefined> {
  try { return await loadState(path) } catch { return undefined }
}

export async function writeState(config: LoadedConfig, fleet: string, path = stateFilePath(), now = Date.now()): Promise<ActivationState> {
  const current = await currentState(path)
  if (current) requireFleet(config, current.fleet)
  requireFleet(config, fleet)
  const state: ActivationState = { version: 1, fleet, fleetActivatedAt: current?.fleet === fleet ? current.fleetActivatedAt : now }
  await atomicWrite(path, state)
  return state
}
