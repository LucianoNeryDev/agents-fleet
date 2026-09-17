import { readFile } from "node:fs/promises"
import { loadConfig, loadFleet } from "./loader.js"
import { stateFilePath } from "./paths.js"
import { loadState, selectState, writeState } from "./state.js"
import { assertContainedPath } from "./validation.js"
import type { ActivationSnapshot, ModelRef, ResolvedArchitecture } from "./types.js"

export function sameModel(left: ModelRef | undefined, right: { providerID?: string; modelID?: string } | undefined): boolean {
  return Boolean(left && right && left.providerID === right.providerID && left.modelID === right.modelID)
}

export function nextFallback(chain: readonly ModelRef[] | undefined, current: { providerID?: string; modelID?: string }): ModelRef | undefined {
  if (!chain) return undefined
  const index = chain.findIndex((model) => sameModel(model, current))
  return chain[index < 0 ? 0 : index + 1]
}

export function errorText(error: unknown): string {
  if (typeof error === "string") return error.toLowerCase()
  if (!error || typeof error !== "object") return String(error ?? "").toLowerCase()
  const item = error as { message?: unknown; type?: unknown; name?: unknown; status?: unknown; data?: { message?: unknown; responseBody?: unknown } }
  return [item.message, item.type, item.name, item.status, item.data?.message, item.data?.responseBody].filter((part) => part !== undefined).join(" ").toLowerCase()
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])
export function isRetryable(error: unknown): boolean {
  const text = errorText(error)
  if (typeof error === "object" && error !== null) {
    const item = error as { status?: unknown; type?: unknown; name?: unknown; data?: { isRetryable?: unknown; statusCode?: unknown } }
    if (typeof item.status === "number" && RETRYABLE.has(item.status)) return true
    if (typeof item.data?.statusCode === "number" && RETRYABLE.has(item.data.statusCode)) return true
    if (item.data?.isRetryable === true || item.type === "ProviderAuthError" || item.name === "ProviderAuthError") return true
  }
  return /rate limit|too many requests|quota|capacity|overloaded|service unavailable|timeout|timed out|throttl|\b(408|409|425|429|500|502|503|504|529)\b/.test(text)
}

function snapshotArchitecture(architecture: ResolvedArchitecture): ResolvedArchitecture {
  return architecture
}

export async function compileSnapshot(configRoot?: string, statePath = stateFilePath(), now = Date.now()): Promise<ActivationSnapshot> {
  const config = await loadConfig(configRoot)
  const selected = await selectState(config, statePath)
  const fleet = await loadFleet(config, selected.architecture, selected.fleet)
  const architecture = snapshotArchitecture(config.architectures.get(selected.architecture)!)
  const prompts = new Map(architecture.prompts)
  const routesByAgent = new Map<string, readonly ModelRef[]>()
  for (const agent of Object.entries(architecture.agents)) if (agent[1].enabled) routesByAgent.set(agent[0], fleet.chains[agent[1].routeSlot!]!)
  const stored = await loadState(statePath)
  const state = stored ?? await writeState(config, selected.architecture, selected.fleet, statePath, now)
  return Object.freeze({ state, architecture, fleet, routesByAgent, prompts, contextSources: new Map(Object.entries(architecture.contextSources)), managedAgentIDs: config.managedAgentIDs })
}

export type RetryEvent = { sessionID: string; agent?: string; model: { providerID: string; modelID?: string; id?: string; variant?: string }; error: unknown; decision?: unknown }
export type ContextEvent = { sessionID: string; agent?: string; system: Array<{ type: "text"; text: string }> }
type SessionAPI = { hook?: (name: string, callback: (event: any) => Promise<void>) => Promise<unknown>; switchModel?: (input: unknown) => Promise<void>; get?: (input: unknown) => Promise<unknown> }

export async function handleRetry(event: RetryEvent, snapshot: ActivationSnapshot, switchModel: (model: ModelRef, sessionID: string) => Promise<void>): Promise<void> {
  if (!isRetryable(event.error)) return
  const current = { providerID: event.model.providerID, modelID: event.model.modelID ?? event.model.id }
  const chain = event.agent ? snapshot.routesByAgent.get(event.agent) : snapshot.fleet.defaultChain
  const next = nextFallback(chain, current)
  if (!next) { event.decision = { retry: false }; return }
  try { await switchModel(next, event.sessionID); event.decision = { retry: true, delay: 0 } }
  catch { event.decision = { retry: false } }
}

async function sessionIsCurrent(session: SessionAPI | undefined, sessionID: string, snapshot: ActivationSnapshot): Promise<void> {
  if (!session?.get || !snapshot.state.architectureActivatedAt) return
  let value: unknown
  try { value = await session.get({ sessionID }) }
  catch (error) { throw new Error(`Unable to verify session age: ${error instanceof Error ? error.message : String(error)}`) }
  const created = value && typeof value === "object" ? (value as { time?: { created?: unknown } }).time?.created : undefined
  if (typeof created === "number" && created < snapshot.state.architectureActivatedAt) throw new Error("This session predates architecture activation; start a new session before using architecture memory.")
}

export async function injectContext(event: ContextEvent, snapshot: ActivationSnapshot, session?: SessionAPI): Promise<void> {
  const agent = event.agent ? snapshot.architecture.agents[event.agent] : undefined
  if (!agent?.enabled) return
  await sessionIsCurrent(session, event.sessionID, snapshot)
  for (const sourceID of agent.contextSourceIDs ?? []) {
    const source = snapshot.contextSources.get(sourceID)
    if (!source) continue
    let content: string
    let safePath: string
    try { safePath = await assertContainedPath(source.architectureDirectory, source.relativePath, `Context source ${sourceID}`) }
    catch (error) { throw new Error(`Context source ${sourceID} failed containment validation: ${error instanceof Error ? error.message : String(error)}`) }
    try { content = await readFile(safePath, "utf8") }
    catch (error) {
      if (!source.required && (error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw new Error(`${source.required ? "Required " : ""}context source ${sourceID} could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (Buffer.byteLength(content, "utf8") > source.maxBytes) throw new Error(`Context source ${sourceID} exceeds its ${source.maxBytes}-byte limit`)
    event.system.push({ type: "text", text: `${source.heading}\n\n${content}` })
  }
}

/** Registers retry/context hooks when the host exposes those V2 runtime domains. */
export async function registerRuntimeHooks(context: { session?: SessionAPI }, snapshot: ActivationSnapshot): Promise<void> {
  const session = context.session
  if (!session?.hook) return
  await session.hook("retry", async (event: RetryEvent) => {
    if (!session.switchModel) return
    await handleRetry(event, snapshot, (model, sessionID) => session.switchModel!({ sessionID, model: { providerID: model.providerID, id: model.modelID, ...(model.variant ? { variant: model.variant } : {}) } }))
  })
  await session.hook("context", async (event: ContextEvent) => injectContext(event, snapshot, session))
}
