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
  routeSlot?: string
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

export type Architecture = Readonly<{
  version: 1
  id: string
  name: string
  description: string
  defaultAgent: string
  agents: Readonly<Record<string, AgentConfig>>
  contextSources: Readonly<Record<string, ContextSource>>
}>

export type Fleet = Readonly<{
  version: 1
  id: string
  name: string
  description: string
  chains: Readonly<Record<string, readonly ModelRef[]>>
  defaultChain?: readonly ModelRef[]
}>

export type ActivationState = Readonly<{
  version: 1
  architecture: string
  fleet: string
  architectureActivatedAt: number
}>

export type ResolvedContextSource = ContextSource & { id: string; path: string; relativePath: string; architectureDirectory: string }
export type ResolvedArchitecture = Architecture & {
  directory: string
  prompts: ReadonlyMap<string, string>
  contextSources: Readonly<Record<string, ResolvedContextSource>>
}
export type LoadedConfig = Readonly<{
  root: string
  architectures: ReadonlyMap<string, ResolvedArchitecture>
  managedAgentIDs: ReadonlySet<string>
}>
export type ActivationSnapshot = Readonly<{
  state: ActivationState
  architecture: ResolvedArchitecture
  fleet: Fleet
  routesByAgent: ReadonlyMap<string, readonly ModelRef[]>
  prompts: ReadonlyMap<string, string>
  contextSources: ReadonlyMap<string, ResolvedContextSource>
  managedAgentIDs: ReadonlySet<string>
}>
