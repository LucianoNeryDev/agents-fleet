import { mkdir, readFile, readdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { configRoot as defaultConfigRoot } from "./paths.js"
import { assertContainedPath, assertID, validateArchitecture, validateFleet } from "./validation.js"
import type { Architecture, Fleet, LoadedConfig, ResolvedArchitecture, ResolvedContextSource } from "./types.js"

async function json(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")) }
  catch (error) { throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`) }
}

export async function loadConfig(root = defaultConfigRoot()): Promise<LoadedConfig> {
  const architectureRoot = join(root, "architectures")
  let entries
  try { entries = await readdir(architectureRoot, { withFileTypes: true }) }
  catch (error) { throw new Error(`Configuration root ${root} has no readable architectures directory: ${error instanceof Error ? error.message : String(error)}`) }
  const directories = entries.filter((entry) => entry.isDirectory() && entry.name !== "node_modules").map((entry) => entry.name).sort()
  if (!directories.length) throw new Error(`Configuration root ${root} contains no architectures`)
  const raw = new Map<string, { value: Architecture; directory: string }>()
  for (const id of directories) {
    assertID(id, `Architecture directory ${id}`)
    const directory = resolve(architectureRoot, id)
    const value = await json(join(directory, "architecture.json")) as Architecture
    validateArchitecture(value)
    if (value.id !== id) throw new Error(`Architecture file ${id}/architecture.json has mismatched ID ${value.id}`)
    raw.set(id, { value, directory })
  }
  const managed = new Set<string>()
  for (const { value } of raw.values()) for (const id of Object.keys(value.agents)) managed.add(id)
  const architectures = new Map<string, ResolvedArchitecture>()
  for (const [id, item] of raw) {
    validateArchitecture(item.value, managed)
    const prompts = new Map<string, string>()
    for (const agent of Object.values(item.value.agents)) {
      if (!agent.enabled || !agent.prompt || agent.prompt.mode === "preserve-static") continue
      for (const path of agent.prompt.paths ?? []) {
        const safe = await assertContainedPath(item.directory, path, `Prompt path ${path}`)
        try { prompts.set(path, await readFile(safe, "utf8")) }
        catch (error) { throw new Error(`Required prompt ${path} for architecture ${id} could not be read: ${error instanceof Error ? error.message : String(error)}`) }
      }
    }
    const contextSources: Record<string, ResolvedContextSource> = {}
    for (const [sourceID, source] of Object.entries(item.value.contextSources)) {
      const path = await assertContainedPath(item.directory, source.path, `Context source ${sourceID}`)
      contextSources[sourceID] = { ...source, id: sourceID, path, relativePath: source.path, architectureDirectory: item.directory }
    }
    architectures.set(id, { ...item.value, directory: item.directory, prompts, contextSources })
  }
  return { root: resolve(root), architectures, managedAgentIDs: managed }
}

export async function loadFleet(config: LoadedConfig, architectureID: string, fleetID: string): Promise<Fleet> {
  const architecture = config.architectures.get(architectureID)
  if (!architecture) throw new Error(`Unknown architecture "${architectureID}"`)
  assertID(fleetID, "Fleet selector")
  const path = join(architecture.directory, "fleets", `${fleetID}.json`)
  const value = await json(path) as Fleet
  if (value.id !== fleetID) throw new Error(`Fleet file ${fleetID}.json has mismatched ID ${value.id}`)
  validateFleet(value, new Set(Object.values(architecture.agents).filter((agent) => agent.enabled).map((agent) => agent.routeSlot!)))
  return value
}

export async function loadAllFleets(config: LoadedConfig, architectureID: string): Promise<ReadonlyMap<string, Fleet>> {
  const architecture = config.architectures.get(architectureID)
  if (!architecture) throw new Error(`Unknown architecture "${architectureID}"`)
  const directory = join(architecture.directory, "fleets")
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) }
  catch (error) { throw new Error(`Architecture ${architectureID} has no readable fleets directory: ${error instanceof Error ? error.message : String(error)}`) }
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name.slice(0, -5)).sort()
  if (!files.length) throw new Error(`Architecture ${architectureID} contains no fleet files`)
  const fleets = new Map<string, Fleet>()
  for (const fleetID of files) fleets.set(fleetID, await loadFleet(config, architectureID, fleetID))
  return fleets
}

export async function ensureConfigDirectories(root: string): Promise<void> {
  await mkdir(join(root, "architectures"), { recursive: true })
}
