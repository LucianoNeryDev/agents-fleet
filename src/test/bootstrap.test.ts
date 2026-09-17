import { test } from "node:test"
import assert from "node:assert/strict"
import { chmod, cp, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { configRoot } from "../paths.js"
import { loadAllFleets, loadConfig, loadFleet } from "../loader.js"
import { compileSnapshot, injectContext, handleRetry } from "../runtime.js"
import { selectState, writeState } from "../state.js"
import { validateArchitecture, validateChain, validateFleet } from "../validation.js"
import { colorsEnabled } from "../cli.js"
import { applyAgentTransform } from "../plugin.js"
import type { Architecture, Fleet } from "../types.js"

const example = fileURLToPath(new URL("../../examples/software-team", import.meta.url))
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agents-fleet-")); await cp(example, root, { recursive: true }); return root
}
async function architecture(root: string, id = "software-team"): Promise<any> { return JSON.parse(await readFile(join(root, `architectures/${id}/architecture.json`), "utf8")) }
async function saveArchitecture(root: string, value: unknown): Promise<void> { await writeFile(join(root, "architectures/software-team/architecture.json"), JSON.stringify(value, null, 2)) }

test("bundled example has valid exhaustive routes and chains", async () => {
  const root = await fixture(); const config = await loadConfig(root); const a = config.architectures.get("software-team")!
  assert.deepEqual([...config.managedAgentIDs], ["build", "coder", "reviewer"])
  assert.deepEqual(Object.keys(a.agents), ["build", "coder", "reviewer"])
  validateArchitecture(await architecture(root), config.managedAgentIDs)
  const fleet = await loadFleet(config, "software-team", "balanced"); validateFleet(fleet, new Set(["build", "coder", "reviewer"]))
})

test("free architecture uses one exact model route for every managed agent", async () => {
  const root = await fixture(); const config = await loadConfig(root); const a = config.architectures.get("free")!
  assert.deepEqual(Object.keys(a.agents), ["build", "coder", "reviewer"])
  assert.deepEqual(Object.fromEntries(Object.entries(a.agents).map(([id, agent]) => [id, { enabled: agent.enabled, mode: agent.mode, routeSlot: agent.routeSlot, prompt: agent.prompt }])), {
    build: { enabled: true, mode: "primary", routeSlot: "all", prompt: { mode: "preserve-static" } },
    coder: { enabled: true, mode: "subagent", routeSlot: "all", prompt: { mode: "preserve-static" } },
    reviewer: { enabled: true, mode: "subagent", routeSlot: "all", prompt: { mode: "preserve-static" } }
  })
  assert.deepEqual(a.contextSources, {})
  const model = { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" }
  const fleet = await loadFleet(config, "free", "free")
  assert.deepEqual(fleet.chains, { all: [model] }); assert.deepEqual(fleet.defaultChain, [model])
  validateArchitecture(await architecture(root, "free"), config.managedAgentIDs); validateFleet(fleet, new Set(["all"]))
})

test("agent steps are positive and prompt policies have matching shapes", () => {
  const valid = { version: 1, id: "shape", name: "Shape", description: "x", defaultAgent: "build", agents: { build: { enabled: true, routeSlot: "build", steps: 1, prompt: { mode: "replace", paths: ["prompt.md"] } } }, contextSources: {} } as unknown as Architecture
  validateArchitecture(valid)
  assert.throws(() => validateArchitecture({ ...valid, agents: { build: { ...valid.agents.build, steps: 0 } } } as Architecture), /invalid steps/)
  assert.throws(() => validateArchitecture({ ...valid, agents: { build: { ...valid.agents.build, prompt: { mode: "preserve-static", paths: ["prompt.md"] } } } } as Architecture), /preserve-static prompt/)
  assert.throws(() => validateArchitecture({ ...valid, agents: { build: { ...valid.agents.build, prompt: { mode: "append", paths: [] } } } } as Architecture), /append prompt/)
})

test("validation rejects duplicate models, bad route slots, and non-terminal OpenRouter", () => {
  const chain = [{ providerID: "a", modelID: "m" }, { providerID: "a", modelID: "m", variant: "other" }]
  assert.throws(() => validateChain(chain, "route"), /duplicate provider\/model/)
  assert.throws(() => validateChain([{ providerID: "openrouter", modelID: "one" }, { providerID: "a", modelID: "two" }], "route"), /after OpenRouter/)
  const fleet = { version: 1, id: "balanced", name: "Balanced", description: "x", chains: { other: [{ providerID: "a", modelID: "m" }] } } as unknown as Fleet
  assert.throws(() => validateFleet(fleet, new Set(["build"])), /missing route slot/)
})

test("all architectures must explicitly declare the managed union", async () => {
  const root = await fixture(); await mkdir(join(root, "architectures/other/fleets"), { recursive: true })
  await writeFile(join(root, "architectures/other/architecture.json"), JSON.stringify({ version: 1, id: "other", name: "Other", description: "x", defaultAgent: "reviewer", agents: { reviewer: { enabled: true, routeSlot: "reviewer" } }, contextSources: {} }))
  await assert.rejects(loadConfig(root), /must explicitly enable or disable managed agent/)
})

test("path traversal and symlink escapes are rejected", async () => {
  const root = await fixture(); const value = await architecture(root); value.contextSources["build-memory"].path = "../outside.md"; await saveArchitecture(root, value)
  await assert.rejects(loadConfig(root), /escapes/)
  const second = await fixture(); const outside = await mkdtemp(join(tmpdir(), "outside-")); await symlink(outside, join(second, "architectures/software-team/link")); const secondValue = await architecture(second); secondValue.contextSources["build-memory"].path = "link/outside.md"; await saveArchitecture(second, secondValue)
  await assert.rejects(loadConfig(second), /symlink/)
})

test("state selection is deterministic, strict, atomic, and preserves architecture boundaries", async () => {
  const root = await fixture(); const config = await loadConfig(root); const statePath = join(root, "state/state.json")
  const initial = await selectState(config, statePath); assert.deepEqual(initial, { version: 1, architecture: "free", fleet: "free", architectureActivatedAt: 0 })
  const setupSnapshot = await compileSnapshot(root, join(root, "setup-state.json"), 300); const restartedSnapshot = await compileSnapshot(root, join(root, "setup-state.json"), 400); assert.equal(setupSnapshot.state.architectureActivatedAt, 300); assert.equal(restartedSnapshot.state.architectureActivatedAt, 300)
  const first = await writeState(config, "software-team", "balanced", statePath, 100); const second = await writeState(config, "software-team", "budget", statePath, 200); assert.equal(second.architectureActivatedAt, first.architectureActivatedAt)
  assert.equal((await readFile(statePath, "utf8")).includes('"fleet": "budget"'), true)
  await writeFile(statePath, JSON.stringify({ version: 1, architecture: "missing", fleet: "budget", architectureActivatedAt: 1 })); await assert.rejects(selectState(config, statePath), /not present in configuration/)
})

test("prompt policies and context enforce one snapshot and session boundary", async () => {
  const root = await fixture(); const statePath = join(root, "state.json"); await writeState(await loadConfig(root), "software-team", "balanced", statePath, 100); const snapshot = await compileSnapshot(root, statePath)
  const agents = new Map<string, any>([["build", { id: "build", request: {}, mode: "primary", hidden: false, permissions: { execute: "ask" }, system: "static" }], ["coder", { id: "coder", request: {}, mode: "subagent", hidden: false, permissions: { execute: "ask" } }], ["reviewer", { id: "reviewer", request: {}, mode: "subagent", hidden: false, permissions: { execute: "ask" } }], ["unmanaged", { id: "unmanaged", request: {}, mode: "all", hidden: false, permissions: { execute: "ask" } }]])
  const draft: any = { get: (id: string) => agents.get(id), update: (id: string, fn: (agent: any) => void) => fn(agents.get(id)), remove: (id: string) => agents.delete(id), default: (id: string) => { draft.selected = id }, list: () => [...agents.values()] }
  applyAgentTransform(draft, snapshot); assert.equal(agents.get("build").system.startsWith("# Build agent"), true); assert.equal(agents.get("build").permissions.execute, "ask"); assert.equal(draft.selected, "build")
  const old = { sessionID: "s", agent: "build", system: [] as any[] }; await assert.rejects(injectContext(old, snapshot, { get: async () => ({ time: { created: 99 } }) }), /predates/)
  const current = { sessionID: "s", agent: "build", system: [] as any[] }; await injectContext(current, snapshot, { get: async () => ({ time: { created: 100 } }) }); assert.equal(current.system.length, 1)
  const appendRoot = await fixture(); const appendValue = await architecture(appendRoot); appendValue.agents.build.prompt = { mode: "append", paths: ["prompts/build.md"] }; await saveArchitecture(appendRoot, appendValue); const appendStatePath = join(appendRoot, "append-state.json"); await writeState(await loadConfig(appendRoot), "software-team", "balanced", appendStatePath); const appendSnapshot = await compileSnapshot(appendRoot, appendStatePath); const appendAgent = new Map([["build", { id: "build", request: {}, mode: "primary", hidden: false, permissions: {}, system: "static system" }], ["coder", { id: "coder", request: {}, mode: "subagent", hidden: false, permissions: {} }], ["reviewer", { id: "reviewer", request: {}, mode: "subagent", hidden: false, permissions: {} }]]); const appendDraft: any = { get: (id: string) => appendAgent.get(id), update: (id: string, fn: (agent: any) => void) => fn(appendAgent.get(id)), remove: () => undefined, default: () => undefined }; applyAgentTransform(appendDraft, appendSnapshot); assert.match(appendAgent.get("build")!.system as string, /^static system\n\n# Build agent/)
})

test("plugin rejects missing enabled agents, removes disabled agents, and handles memory failures", async () => {
  const root = await fixture(); const config = await loadConfig(root); const snapshot = await compileSnapshot(root, join(root, "state.json"))
  const agents = new Map<string, any>([["build", { id: "build", request: {}, mode: "primary", hidden: false, permissions: {} }], ["coder", { id: "coder", request: {}, mode: "subagent", hidden: false, permissions: {} }], ["reviewer", { id: "reviewer", request: {}, mode: "subagent", hidden: false, permissions: {} }], ["unmanaged", { id: "unmanaged", request: {}, mode: "all", hidden: false, permissions: {} }]])
  const draft: any = { get: (id: string) => agents.get(id), update: (id: string, fn: (agent: any) => void) => fn(agents.get(id)), remove: (id: string) => agents.delete(id), default: () => undefined }
  applyAgentTransform(draft, snapshot); assert.equal(agents.has("unmanaged"), true)
  const missing = new Map(agents); missing.delete("reviewer"); assert.throws(() => applyAgentTransform({ ...draft, get: (id: string) => missing.get(id) }, snapshot), /missing enabled agent/)
  const disabledRoot = await fixture(); const disabledValue = await architecture(disabledRoot); disabledValue.agents.coder = { enabled: false }; delete disabledValue.contextSources["coder-memory"]; await saveArchitecture(disabledRoot, disabledValue)
  for (const fleetID of ["balanced", "budget"]) { const fleetPath = join(disabledRoot, `architectures/software-team/fleets/${fleetID}.json`); const fleet = JSON.parse(await readFile(fleetPath, "utf8")); delete fleet.chains.coder; await writeFile(fleetPath, JSON.stringify(fleet, null, 2)) }
  const disabledStatePath = join(disabledRoot, "disabled-state.json"); await writeState(await loadConfig(disabledRoot), "software-team", "balanced", disabledStatePath); const disabledSnapshot = await compileSnapshot(disabledRoot, disabledStatePath); const disabledAgents = new Map(agents); const disabledDraft: any = { get: (id: string) => disabledAgents.get(id), update: (id: string, fn: (agent: any) => void) => fn(disabledAgents.get(id)), remove: (id: string) => disabledAgents.delete(id), default: () => undefined }; applyAgentTransform(disabledDraft, disabledSnapshot); assert.equal(disabledAgents.has("coder"), false)
  const value = await architecture(root); value.contextSources["reviewer-memory"].path = "memory/not-there.md"; await saveArchitecture(root, value); value.contextSources["reviewer-memory"].required = true; await saveArchitecture(root, value)
  const requiredStatePath = join(root, "required-state.json"); await writeState(await loadConfig(root), "software-team", "balanced", requiredStatePath); const requiredSnapshot = await compileSnapshot(root, requiredStatePath); await assert.rejects(injectContext({ sessionID: "s", agent: "reviewer", system: [] }, requiredSnapshot), /Required context source/)
  value.contextSources["reviewer-memory"].required = false; value.contextSources["reviewer-memory"].maxBytes = 1; value.contextSources["reviewer-memory"].path = "memory/reviewer.md"; await saveArchitecture(root, value)
  const optionalRoot = await fixture(); const optionalValue = await architecture(optionalRoot); optionalValue.contextSources["reviewer-memory"].path = "memory/not-there.md"; optionalValue.contextSources["reviewer-memory"].required = false; await saveArchitecture(optionalRoot, optionalValue); const optionalStatePath = join(optionalRoot, "optional-state.json"); await writeState(await loadConfig(optionalRoot), "software-team", "balanced", optionalStatePath); const optionalSnapshot = await compileSnapshot(optionalRoot, optionalStatePath); const optionalEvent = { sessionID: "s", agent: "reviewer", system: [] as any[] }; await injectContext(optionalEvent, optionalSnapshot); assert.equal(optionalEvent.system.length, 0)
  const outsideMemory = await mkdtemp(join(tmpdir(), "outside-memory-")); const laterPath = join(optionalRoot, "architectures/software-team/memory/later.md"); const laterEvent = { sessionID: "s", agent: "reviewer", system: [] as any[] }; optionalValue.contextSources["reviewer-memory"].path = "memory/later.md"; await saveArchitecture(optionalRoot, optionalValue); const laterStatePath = join(optionalRoot, "later-state.json"); await writeState(await loadConfig(optionalRoot), "software-team", "balanced", laterStatePath); const laterSnapshot = await compileSnapshot(optionalRoot, laterStatePath); await writeFile(join(outsideMemory, "later.md"), "outside"); await symlink(join(outsideMemory, "later.md"), laterPath); await assert.rejects(injectContext(laterEvent, laterSnapshot), /containment validation/)
  value.contextSources["reviewer-memory"].required = false; value.contextSources["reviewer-memory"].path = "memory/reviewer.md"; value.contextSources["reviewer-memory"].maxBytes = 1; await saveArchitecture(root, value); const oversizeStatePath = join(root, "oversize-state.json"); await writeState(await loadConfig(root), "software-team", "balanced", oversizeStatePath); const oversizeSnapshot = await compileSnapshot(root, oversizeStatePath); await assert.rejects(injectContext({ sessionID: "s", agent: "reviewer", system: [] }, oversizeSnapshot), /exceeds/)
})

test("retry advances fallback and chooses primary when current is unknown", async () => {
  const root = await fixture(); const statePath = join(root, "missing-state.json"); const config = await loadConfig(root); await writeState(config, "software-team", "balanced", statePath); const snapshot = await compileSnapshot(root, statePath); const event: any = { sessionID: "s", agent: "coder", model: { providerID: "unknown", modelID: "model" }, error: { status: 503 } }; let switched: any
  await handleRetry(event, snapshot, async (model) => { switched = model }); assert.equal(switched.providerID, "anthropic"); assert.deepEqual(event.decision, { retry: true, delay: 0 })
})

test("CLI colors, init no-overwrite, validate, list, and use use a fake executable", async () => {
  assert.equal(colorsEnabled({ NO_COLOR: "1", FORCE_COLOR: "1" }, true), false); assert.equal(colorsEnabled({ FORCE_COLOR: "1" }, false), true); assert.equal(colorsEnabled({}, false), false)
  const root = await mkdtemp(join(tmpdir(), "agents-fleet-cli-")); const cli = fileURLToPath(new URL("../cli.js", import.meta.url)); const init = spawnSync(process.execPath, [cli, "init", root], { encoding: "utf8" }); assert.equal(init.status, 0, init.stderr)
  const initialized = await loadConfig(root)
  for (const [architectureID, fleetIDs] of [["free", ["free"]], ["software-team", ["balanced", "budget"]]] as const) {
    const architecturePath = join(root, `architectures/${architectureID}/architecture.json`); assert.equal(existsSync(resolve(dirname(architecturePath), JSON.parse(await readFile(architecturePath, "utf8")).$schema)), true)
    await loadAllFleets(initialized, architectureID)
    for (const fleetID of fleetIDs) { const fleetPath = join(root, `architectures/${architectureID}/fleets/${fleetID}.json`); assert.equal(existsSync(resolve(dirname(fleetPath), JSON.parse(await readFile(fleetPath, "utf8")).$schema)), true) }
  }
  const initializedFiles = ["architectures/free/architecture.json", "architectures/free/fleets/free.json", "architectures/software-team/architecture.json", "architectures/software-team/fleets/balanced.json", "architectures/software-team/fleets/budget.json"]
  const before = await Promise.all(initializedFiles.map((path) => readFile(join(root, path), "utf8")))
  const marker = join(root, "restart.txt"); const executable = join(root, "fake-opencode"); await writeFile(executable, `#!/bin/sh\necho restarted > '${marker}'\n`); await chmod(executable, 0o755)
  const env = { ...process.env, AGENTS_FLEET_HOME: root, XDG_STATE_HOME: join(root, "xdg-state"), OPENCODE_BIN: executable, NO_COLOR: "1" }; const validate = spawnSync(process.execPath, [cli, "validate"], { env, encoding: "utf8" }); assert.equal(validate.status, 0, validate.stderr)
  const current = spawnSync(process.execPath, [cli, "current"], { env, encoding: "utf8" }); assert.equal(current.status, 0); assert.equal(current.stdout.trim(), "free/free")
  const showArchitecture = spawnSync(process.execPath, [cli, "show", "free"], { env, encoding: "utf8" }); assert.equal(showArchitecture.status, 0); assert.match(showArchitecture.stdout, /Architecture: free/); assert.match(showArchitecture.stdout, /free \(active\)/)
  const showFree = spawnSync(process.execPath, [cli, "show", "free/free"], { env, encoding: "utf8" }); assert.equal(showFree.status, 0); assert.match(showFree.stdout, /Fleet: free/); assert.match(showFree.stdout, /opencode\/muse-spark-1\.3-contributor-free/)
  const showExplicit = spawnSync(process.execPath, [cli, "show", "software-team/budget"], { env, encoding: "utf8" }); assert.equal(showExplicit.status, 0); assert.match(showExplicit.stdout, /Fleet: budget/)
  const list = spawnSync(process.execPath, [cli, "list"], { env, encoding: "utf8" }); assert.match(list.stdout, /free/); assert.match(list.stdout, /software-team/); assert.equal(/\x1b\[/.test(list.stdout), false)
  const coloredEnv: NodeJS.ProcessEnv = { ...env, FORCE_COLOR: "1" }; delete coloredEnv.NO_COLOR; const colored = spawnSync(process.execPath, [cli, "show", "free/free"], { env: coloredEnv, encoding: "utf8" }); assert.match(colored.stdout, /\x1b\[35mfree\x1b\[0m/); assert.match(colored.stdout, /\x1b\[36mall\x1b\[0m/); assert.match(colored.stdout, /\x1b\[32mopencode\/muse-spark-1\.3-contributor-free\x1b\[0m/)
  const use = spawnSync(process.execPath, [cli, "use", "software-team/budget"], { env, encoding: "utf8" }); assert.equal(use.status, 0, use.stderr); assert.equal((await readFile(marker, "utf8")).trim(), "restarted"); assert.match((await readFile(join(root, "xdg-state/agents-fleet/state.json"), "utf8")), /"architecture": "software-team"/)
  const again = spawnSync(process.execPath, [cli, "init", root], { encoding: "utf8" }); assert.equal(again.status, 0); const after = await Promise.all(initializedFiles.map((path) => readFile(join(root, path), "utf8"))); assert.deepEqual(after, before)
})
