import { define, type PluginContext } from "@opencode-ai/plugin/v2/promise"
import type { AgentDraft } from "@opencode-ai/plugin/v2/promise"
import { compileSnapshot, registerRuntimeHooks } from "./runtime.js"
import type { AgentConfig, ActivationSnapshot, ModelRef } from "./types.js"
import { configRoot } from "./paths.js"

function optionString(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key]
  if (value !== undefined && typeof value !== "string") throw new Error(`Plugin option ${key} must be a string`)
  return value as string | undefined
}

function modelRef(model: ModelRef): { providerID: string; id: string; variant?: string } {
  return { providerID: model.providerID, id: model.modelID, ...(model.variant ? { variant: model.variant } : {}) }
}

function promptText(spec: AgentConfig, snapshot: ActivationSnapshot): string | undefined {
  const prompt = spec.prompt
  if (!prompt || prompt.mode === "preserve-static") return undefined
  return (prompt.paths ?? []).map((path) => snapshot.prompts.get(path) ?? "").join("\n\n")
}

function transformAgents(draft: AgentDraft, snapshot: ActivationSnapshot): void {
  const enabled = Object.entries(snapshot.fleet.agents).filter(([, spec]) => spec.enabled)
  const missing = enabled.map(([id]) => id).filter((id) => !draft.get(id))
  if (missing.length) throw new Error(`Fleet ${snapshot.fleet.id} requires missing enabled agent(s): ${missing.join(", ")}`)
  for (const id of snapshot.managedAgentIDs) {
    const spec = snapshot.fleet.agents[id]
    if (spec && !spec.enabled && draft.get(id)) draft.remove(id)
  }
  for (const [id, spec] of enabled) {
    const chain = snapshot.chainsByAgent.get(id)
    if (!chain) throw new Error(`Agent ${id} has no line chain in the active snapshot`)
    draft.update(id, (agent) => {
      agent.model = modelRef(chain[0])
      if (spec.mode !== undefined && spec.mode !== "preserve-static") agent.mode = spec.mode
      if (spec.hidden !== undefined && spec.hidden !== "preserve-static") agent.hidden = spec.hidden
      if (spec.description !== undefined && spec.description !== "preserve-static") agent.description = spec.description
      if (spec.steps !== undefined && spec.steps !== "preserve-static") agent.steps = spec.steps
      const prompt = promptText(spec, snapshot)
      if (prompt !== undefined) agent.system = spec.prompt?.mode === "append" && agent.system ? `${agent.system}\n\n${prompt}` : prompt
    })
  }
  draft.default(snapshot.fleet.defaultAgent)
}

export function applyAgentTransform(draft: AgentDraft, snapshot: ActivationSnapshot): void { transformAgents(draft, snapshot) }

export default define({
  id: "agents-fleet",
  async setup(context: PluginContext) {
    const options = (context.options ?? {}) as Record<string, unknown>
    const root = configRoot(optionString(options, "configRoot"), process.env)
    const snapshot = await compileSnapshot(root, optionString(options, "statePath"))
    await context.agent.transform((draft) => transformAgents(draft, snapshot))
    // These domains are not present in every V2 SDK build yet. Keeping the
    // registration adapter separate lets hosts that expose them use the same
    // immutable setup snapshot without falling back to a V1 plugin API.
    await registerRuntimeHooks(context as unknown as { session?: Parameters<typeof registerRuntimeHooks>[0]["session"] }, snapshot)
  },
})
