import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { stateFilePath } from "./paths.js"
import type { ActivationState, LoadedConfig } from "./types.js"
import { assertID } from "./validation.js"
import { loadAllFleets, loadFleet } from "./loader.js"

export function parseState(text: string, source = "agents-fleet state"): ActivationState {
  let value: unknown
  try { value = JSON.parse(text) } catch (error) { throw new Error(`Invalid ${source}: malformed JSON (${error instanceof Error ? error.message : String(error)})`) }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${source}: expected version 1 state`)
  const item = value as Record<string, unknown>
  if (Object.keys(item).sort().join(",") !== "architecture,architectureActivatedAt,fleet,version") throw new Error(`Invalid ${source}: unsupported fields`)
  if (item.version !== 1 || typeof item.architecture !== "string" || typeof item.fleet !== "string" || typeof item.architectureActivatedAt !== "number" || !Number.isSafeInteger(item.architectureActivatedAt) || (item.architectureActivatedAt as number) < 0) throw new Error(`Invalid ${source}: expected version 1 architecture/fleet state`)
  assertID(item.architecture, "State architecture"); assertID(item.fleet, "State fleet")
  return item as ActivationState
}

export async function loadState(path = stateFilePath()): Promise<ActivationState | undefined> {
  try { return parseState(await readFile(path, "utf8"), path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
}

export async function selectState(config: LoadedConfig, path = stateFilePath()): Promise<ActivationState> {
  const stored = await loadState(path)
  if (stored) {
    if (!config.architectures.has(stored.architecture)) throw new Error(`Persisted architecture "${stored.architecture}" is not present in configuration`)
    const fleets = await loadAllFleets(config, stored.architecture)
    if (!fleets.has(stored.fleet)) throw new Error(`Persisted fleet "${stored.fleet}" is not present in architecture "${stored.architecture}"`)
    return stored
  }
  const architectureID = [...config.architectures.keys()].sort()[0]
  const fleets = await loadAllFleets(config, architectureID)
  const fleetID = [...fleets.keys()].sort()[0]
  return { version: 1, architecture: architectureID, fleet: fleetID, architectureActivatedAt: 0 }
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

export async function writeState(config: LoadedConfig, architecture: string, fleet: string, path = stateFilePath(), now = Date.now()): Promise<ActivationState> {
  const current = await loadState(path)
  if (current) await loadFleet(config, current.architecture, current.fleet)
  await loadFleet(config, architecture, fleet)
  const state: ActivationState = { version: 1, architecture, fleet, architectureActivatedAt: current?.architecture === architecture ? current.architectureActivatedAt : now }
  await atomicWrite(path, state)
  return state
}
