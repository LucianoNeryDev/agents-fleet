import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { Architecture, AgentConfig, ContextSource, Fleet, ModelRef } from "./types.js"

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const AGENT_MODES = new Set(["primary", "subagent", "all"])

export function isValidID(value: unknown): value is string { return typeof value === "string" && ID.test(value) }
export function assertID(value: unknown, label: string): asserts value is string {
  if (!isValidID(value)) throw new Error(`${label} must be a lowercase kebab-case ID`)
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
function noUnknown(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new Error(`${label} contains unsupported field(s): ${unknown.join(", ")}`)
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
}
function model(value: unknown, label: string): asserts value is ModelRef {
  const candidate = object(value, label)
  noUnknown(candidate, ["providerID", "modelID", "variant"], label)
  text(candidate.providerID, `${label}.providerID`)
  text(candidate.modelID, `${label}.modelID`)
  if (candidate.variant !== undefined) text(candidate.variant, `${label}.variant`)
}
export function modelKey(value: ModelRef): string { return `${value.providerID}/${value.modelID}` }
export function validateChain(value: unknown, label: string): asserts value is readonly ModelRef[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must contain at least one model`)
  const seen = new Set<string>()
  let openRouter = false
  value.forEach((entry, index) => {
    model(entry, `${label}[${index}]`)
    const key = modelKey(entry)
    if (seen.has(key)) throw new Error(`${label} contains duplicate provider/model ${key}`)
    seen.add(key)
    if (entry.providerID === "openrouter") openRouter = true
    else if (openRouter) throw new Error(`${label} has a non-OpenRouter model after OpenRouter`)
  })
}

function validateAgent(id: string, value: unknown): asserts value is AgentConfig {
  const agent = object(value, `Agent ${id}`)
  noUnknown(agent, ["enabled", "routeSlot", "mode", "hidden", "description", "steps", "prompt", "contextSourceIDs"], `Agent ${id}`)
  if (typeof agent.enabled !== "boolean") throw new Error(`Agent ${id} must explicitly set enabled or disabled`)
  if (!agent.enabled) {
    if (Object.keys(agent).some((key) => key !== "enabled")) throw new Error(`Disabled agent ${id} cannot contain behavior configuration`)
    return
  }
  if (agent.routeSlot !== undefined) assertID(agent.routeSlot, `Agent ${id} routeSlot`)
  else throw new Error(`Enabled agent ${id} must have a routeSlot`)
  if (agent.mode !== undefined && agent.mode !== "preserve-static" && !AGENT_MODES.has(agent.mode as string)) throw new Error(`Agent ${id} has an invalid mode`)
  if (agent.hidden !== undefined && agent.hidden !== "preserve-static" && typeof agent.hidden !== "boolean") throw new Error(`Agent ${id} has an invalid hidden value`)
  if (agent.description !== undefined && agent.description !== "preserve-static" && typeof agent.description !== "string") throw new Error(`Agent ${id} has an invalid description`)
  if (agent.steps !== undefined && agent.steps !== "preserve-static" && (!Number.isSafeInteger(agent.steps) || (agent.steps as number) <= 0)) throw new Error(`Agent ${id} has invalid steps`)
  if (agent.prompt !== undefined) {
    const prompt = object(agent.prompt, `Agent ${id} prompt`)
    noUnknown(prompt, ["mode", "paths"], `Agent ${id} prompt`)
    if (!['preserve-static', 'replace', 'append'].includes(prompt.mode as string)) throw new Error(`Agent ${id} has an invalid prompt mode`)
    if (prompt.paths !== undefined) {
      if (!Array.isArray(prompt.paths) || prompt.paths.some((path) => typeof path !== "string" || isAbsolute(path) || path.includes("\0"))) throw new Error(`Agent ${id} prompt paths must be relative strings`)
      if ((prompt.mode === "replace" || prompt.mode === "append") && prompt.paths.length === 0) throw new Error(`Agent ${id} ${prompt.mode} prompt policy must name files`)
    } else if (prompt.mode !== "preserve-static") throw new Error(`Agent ${id} ${prompt.mode} prompt policy must name files`)
    if ((prompt.mode === "preserve-static") && prompt.paths?.length) throw new Error(`Agent ${id} preserve-static prompt cannot name files`)
  }
  if (agent.contextSourceIDs !== undefined) {
    if (!Array.isArray(agent.contextSourceIDs) || new Set(agent.contextSourceIDs).size !== agent.contextSourceIDs.length) throw new Error(`Agent ${id} repeats a context source`)
    for (const sourceID of agent.contextSourceIDs) assertID(sourceID, `Agent ${id} context source ID`)
  }
}

export function validateFleet(fleet: Fleet, requiredSlots?: ReadonlySet<string>): void {
  const value = object(fleet, "Fleet")
  noUnknown(value, ["$schema", "version", "id", "name", "description", "chains", "defaultChain"], "Fleet")
  if (value.version !== 1) throw new Error("Fleet version must be 1")
  assertID(value.id, "Fleet ID"); text(value.name, `Fleet ${String(value.id)} name`); text(value.description, `Fleet ${String(value.id)} description`)
  const chains = object(value.chains, `Fleet ${String(value.id)} chains`)
  const slots = Object.keys(chains)
  if (!slots.length) throw new Error(`Fleet ${String(value.id)} must contain route-slot chains`)
  for (const slot of slots) { assertID(slot, `Fleet ${String(value.id)} route slot`); validateChain(chains[slot], `Fleet ${String(value.id)} route slot ${slot}`) }
  if (value.defaultChain !== undefined) validateChain(value.defaultChain, `Fleet ${String(value.id)} defaultChain`)
  if (requiredSlots) {
    for (const slot of requiredSlots) if (!Object.hasOwn(chains, slot)) throw new Error(`Fleet ${String(value.id)} is missing route slot ${slot}`)
    for (const slot of slots) if (!requiredSlots.has(slot)) throw new Error(`Fleet ${String(value.id)} contains unknown route slot ${slot}`)
  }
}

export function validateArchitecture(architecture: Architecture, managedAgentIDs?: ReadonlySet<string>): void {
  const value = object(architecture, "Architecture")
  noUnknown(value, ["$schema", "version", "id", "name", "description", "defaultAgent", "agents", "contextSources"], "Architecture")
  if (value.version !== 1) throw new Error("Architecture version must be 1")
  assertID(value.id, "Architecture ID"); text(value.name, `Architecture ${String(value.id)} name`); text(value.description, `Architecture ${String(value.id)} description`); assertID(value.defaultAgent, "Architecture defaultAgent")
  const agents = object(value.agents, `Architecture ${String(value.id)} agents`)
  if (!Object.keys(agents).length) throw new Error(`Architecture ${String(value.id)} must contain agents`)
  if (!Object.hasOwn(agents, value.defaultAgent as string)) throw new Error(`Architecture ${String(value.id)} defaultAgent is not in its roster`)
  const enabledSlots = new Set<string>()
  for (const [id, agent] of Object.entries(agents)) { assertID(id, "Architecture agent ID"); validateAgent(id, agent); if ((agent as AgentConfig).enabled) enabledSlots.add((agent as AgentConfig).routeSlot!) }
  if (!(agents[value.defaultAgent as string] as AgentConfig).enabled) throw new Error(`Architecture ${String(value.id)} defaultAgent must be enabled`)
  if (managedAgentIDs) for (const id of managedAgentIDs) if (!Object.hasOwn(agents, id)) throw new Error(`Architecture ${String(value.id)} must explicitly enable or disable managed agent ${id}`)
  const sources = object(value.contextSources, `Architecture ${String(value.id)} contextSources`)
  for (const [id, source] of Object.entries(sources)) {
    assertID(id, "Context source ID")
    const item = object(source, `Context source ${id}`)
    noUnknown(item, ["ownerAgentID", "path", "required", "heading", "maxBytes"], `Context source ${id}`)
    assertID(item.ownerAgentID, `Context source ${id} ownerAgentID`); text(item.path, `Context source ${id} path`)
    if (isAbsolute(item.path) || item.path.includes("\0")) throw new Error(`Context source ${id} path must be relative`)
    if (typeof item.required !== "boolean") throw new Error(`Context source ${id} required must be boolean`); text(item.heading, `Context source ${id} heading`)
    if (!Number.isSafeInteger(item.maxBytes) || (item.maxBytes as number) <= 0) throw new Error(`Context source ${id} maxBytes must be a positive safe integer`)
    const owner = agents[item.ownerAgentID as string] as AgentConfig | undefined
    if (!owner?.enabled) throw new Error(`Context source ${id} must belong to an enabled agent`)
    if (!(owner.contextSourceIDs ?? []).includes(id)) throw new Error(`Context source ${id} is not bound to its exact owner agent`)
  }
  for (const [id, agent] of Object.entries(agents)) for (const sourceID of (agent as AgentConfig).contextSourceIDs ?? []) {
    if (!Object.hasOwn(sources, sourceID)) throw new Error(`Agent ${id} references unknown context source ${sourceID}`)
    if ((sources[sourceID] as ContextSource).ownerAgentID !== id) throw new Error(`Context source ${sourceID} is owned by ${(sources[sourceID] as ContextSource).ownerAgentID}, not ${id}`)
  }
  const fleets = (value as unknown as { fleets?: unknown }).fleets
  if (fleets !== undefined) throw new Error(`Architecture ${String(value.id)} must keep fleets in separate files`)
  if (!enabledSlots.size) throw new Error(`Architecture ${String(value.id)} must enable at least one agent`)
}

export async function assertContainedPath(root: string, relativePath: string, label: string): Promise<string> {
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes("\0")) throw new Error(`${label} must be a relative path`)
  const base = await realpath(root)
  const candidate = resolve(base, relativePath)
  const lexical = relative(base, candidate)
  if (lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) throw new Error(`${label} escapes its architecture directory`)
  let probe = candidate
  while (true) {
    try {
      const resolved = await realpath(probe)
      const rel = relative(base, resolved)
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} escapes its architecture directory through a symlink`)
      return probe === candidate ? resolved : candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const parent = resolve(probe, "..")
      if (parent === probe) throw new Error(`${label} has no existing parent`) 
      probe = parent
    }
  }
}
