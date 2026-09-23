import { mkdir, readFile, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { configRoot as defaultConfigRoot } from "./paths.js"
import { assertContainedPath, assertID, lineID, validateFleet, validateLine } from "./validation.js"
import type { Fleet, Line, LineCatalog, LoadedConfig, ResolvedContextSource, ResolvedFleet } from "./types.js"

async function json(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")) }
  catch (error) { throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`) }
}

async function readJSONDirectory(directory: string, label: string): Promise<Array<{ id: string; path: string }>> {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) }
  catch (error) { throw new Error(`${label} is not readable: ${error instanceof Error ? error.message : String(error)}`) }
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => ({ id: entry.name.slice(0, -5), path: join(directory, entry.name) })).sort((left, right) => left.id.localeCompare(right.id))
}

/** Loads the shared line catalog. Lines are global: no fleet owns one. */
export async function loadLines(root: string): Promise<LineCatalog> {
  const directory = join(root, "lines")
  const files = await readJSONDirectory(directory, `Line catalog ${directory}`)
  if (!files.length) throw new Error(`Configuration root ${root} contains no lines`)
  const lines = new Map<string, Line>()
  for (const file of files) {
    assertID(file.id, `Line file ${file.id}`)
    const value = await json(file.path) as Line
    validateLine(value)
    if (value.id !== file.id) throw new Error(`Line file ${file.id}.json has mismatched ID ${value.id}`)
    lines.set(file.id, value)
  }
  return lines
}

export async function loadConfig(root = defaultConfigRoot()): Promise<LoadedConfig> {
  const lines = await loadLines(root)
  const lineIDs = new Set(lines.keys())
  const fleetRoot = join(root, "fleets")
  let entries
  try { entries = await readdir(fleetRoot, { withFileTypes: true }) }
  catch (error) { throw new Error(`Configuration root ${root} has no readable fleets directory: ${error instanceof Error ? error.message : String(error)}`) }
  const directories = entries.filter((entry) => entry.isDirectory() && entry.name !== "node_modules").map((entry) => entry.name).sort()
  if (!directories.length) throw new Error(`Configuration root ${root} contains no fleets`)
  const raw = new Map<string, { value: Fleet; directory: string }>()
  for (const id of directories) {
    assertID(id, `Fleet directory ${id}`)
    const directory = resolve(fleetRoot, id)
    const value = await json(join(directory, "fleet.json")) as Fleet
    validateFleet(value, undefined, lineIDs)
    if (value.id !== id) throw new Error(`Fleet file ${id}/fleet.json has mismatched ID ${value.id}`)
    raw.set(id, { value, directory })
  }
  const managed = new Set<string>()
  for (const { value } of raw.values()) for (const id of Object.keys(value.agents)) managed.add(id)
  const fleets = new Map<string, ResolvedFleet>()
  for (const [id, item] of raw) {
    validateFleet(item.value, managed, lineIDs)
    const prompts = new Map<string, string>()
    for (const agent of Object.values(item.value.agents)) {
      if (!agent.enabled || !agent.prompt || agent.prompt.mode === "preserve-static") continue
      for (const path of agent.prompt.paths ?? []) {
        const safe = await assertContainedPath(item.directory, path, `Prompt path ${path}`)
        try { prompts.set(path, await readFile(safe, "utf8")) }
        catch (error) { throw new Error(`Required prompt ${path} for fleet ${id} could not be read: ${error instanceof Error ? error.message : String(error)}`) }
      }
    }
    const contextSources: Record<string, ResolvedContextSource> = {}
    for (const [sourceID, source] of Object.entries(item.value.contextSources)) {
      const path = await assertContainedPath(item.directory, source.path, `Context source ${sourceID}`)
      contextSources[sourceID] = { ...source, id: sourceID, path, relativePath: source.path, fleetDirectory: item.directory }
    }
    const linesByAgent = new Map<string, Line>()
    for (const [agentID, agent] of Object.entries(item.value.agents)) {
      if (!agent.enabled) continue
      linesByAgent.set(agentID, lines.get(lineID(agent.line!))!)
    }
    const defaultLine = item.value.defaultLine ? lines.get(lineID(item.value.defaultLine)) : undefined
    const { defaultLine: _reference, ...fleet } = item.value
    fleets.set(id, { ...fleet, directory: item.directory, prompts, contextSources, linesByAgent, ...(defaultLine ? { defaultLine } : {}) })
  }
  return { root: resolve(root), fleets, lines, managedAgentIDs: managed }
}

export function requireFleet(config: LoadedConfig, fleetID: string): ResolvedFleet {
  assertID(fleetID, "Fleet selector")
  const fleet = config.fleets.get(fleetID)
  if (!fleet) throw new Error(`Unknown fleet "${fleetID}"`)
  return fleet
}

export function requireLine(config: LoadedConfig, id: string): Line {
  assertID(id, "Line selector")
  const line = config.lines.get(id)
  if (!line) throw new Error(`Unknown line "${id}"`)
  return line
}

export async function ensureConfigDirectories(root: string): Promise<void> {
  await mkdir(join(root, "fleets"), { recursive: true })
  await mkdir(join(root, "lines"), { recursive: true })
}
