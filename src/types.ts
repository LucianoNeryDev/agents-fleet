export type ModelRef = Readonly<{
  providerID: string
  modelID: string
  variant?: string
}>

export type AgentMode = "primary" | "subagent" | "all"
export type StaticField<T> = T | "preserve-static"
export type PromptPolicy = Readonly<{
  mode: "preserve-static" | "replace" | "append"
  paths?: readonly string[]
}>

export type AgentConfig = Readonly<{
  enabled: boolean
  /** Line reference in `$name` form, for example `$heavy`. */
  line?: string
  mode?: StaticField<AgentMode>
  hidden?: StaticField<boolean>
  description?: StaticField<string>
  steps?: StaticField<number>
  prompt?: PromptPolicy
  contextSourceIDs?: readonly string[]
}>

export type ContextSource = Readonly<{
  ownerAgentID: string
  path: string
  required: boolean
  heading: string
  maxBytes: number
}>

/** A named model chain: one primary followed by optional fallbacks. */
export type Line = Readonly<{
  version: 1
  id: string
  name: string
  description: string
  chain: readonly ModelRef[]
}>

/** The shared line catalog. Lines are global; no fleet owns one. */
export type LineCatalog = ReadonlyMap<string, Line>

export type Fleet = Readonly<{
  version: 1
  id: string
  name: string
  description: string
  defaultAgent: string
  /** Line reference used when a runtime event names no agent. */
  defaultLine?: string
  agents: Readonly<Record<string, AgentConfig>>
  contextSources: Readonly<Record<string, ContextSource>>
}>

export type ActivationState = Readonly<{
  version: 1
  fleet: string
  fleetActivatedAt: number
}>

export type ResolvedContextSource = ContextSource & { id: string; path: string; relativePath: string; fleetDirectory: string }
export type ResolvedFleet = Omit<Fleet, "defaultLine" | "contextSources"> & {
  directory: string
  prompts: ReadonlyMap<string, string>
  contextSources: Readonly<Record<string, ResolvedContextSource>>
  linesByAgent: ReadonlyMap<string, Line>
  defaultLine?: Line
}
export type LoadedConfig = Readonly<{
  root: string
  fleets: ReadonlyMap<string, ResolvedFleet>
  lines: LineCatalog
  managedAgentIDs: ReadonlySet<string>
}>
export type ActivationSnapshot = Readonly<{
  state: ActivationState
  fleet: ResolvedFleet
  lines: LineCatalog
  chainsByAgent: ReadonlyMap<string, readonly ModelRef[]>
  defaultChain?: readonly ModelRef[]
  prompts: ReadonlyMap<string, string>
  contextSources: ReadonlyMap<string, ResolvedContextSource>
  managedAgentIDs: ReadonlySet<string>
}>
