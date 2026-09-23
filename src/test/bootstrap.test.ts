import { test } from "node:test"
import assert from "node:assert/strict"
import { chmod, cp, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { loadConfig, requireFleet, requireLine } from "../loader.js"
import { compileSnapshot, injectContext, handleRetry } from "../runtime.js"
import { selectState, writeState } from "../state.js"
import { validateChain, validateFleet, validateLine } from "../validation.js"
import { colorsEnabled } from "../cli.js"
import { applyAgentTransform } from "../plugin.js"
import type { Fleet, Line } from "../types.js"

const example = fileURLToPath(new URL("../../examples/software-team", import.meta.url))
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agents-fleet-")); await cp(example, root, { recursive: true }); return root
}
async function fleetDocument(root: string, id = "software-team"): Promise<any> { return JSON.parse(await readFile(join(root, `fleets/${id}/fleet.json`), "utf8")) }
async function saveFleet(root: string, value: unknown, id = "software-team"): Promise<void> { await writeFile(join(root, `fleets/${id}/fleet.json`), JSON.stringify(value, null, 2)) }

test("bundled example has a shared line catalog and exhaustive fleets", async () => {
  const root = await fixture(); const config = await loadConfig(root)
  assert.deepEqual([...config.managedAgentIDs], ["build", "coder", "reviewer"])
  assert.deepEqual([...config.lines.keys()], ["economy", "free", "frontier", "standard"])
  const lineIDs = new Set(config.lines.keys())
  const fleet = requireFleet(config, "software-team")
  assert.deepEqual(Object.keys(fleet.agents), ["build", "coder", "reviewer"])
  validateFleet(await fleetDocument(root), config.managedAgentIDs, lineIDs)
  assert.deepEqual([...fleet.linesByAgent].map(([id, line]) => `${id}->$${line.id}`), ["build->$frontier", "coder->$standard", "reviewer->$economy"])
  assert.equal(fleet.defaultLine?.id, "frontier")
  assert.equal(requireLine(config, "standard").chain.length, 2)
})

test("the free fleet binds one shared zero-cost line for every managed agent", async () => {
  const root = await fixture(); const config = await loadConfig(root); const fleet = requireFleet(config, "free")
  assert.deepEqual(Object.fromEntries(Object.entries(fleet.agents).map(([id, agent]) => [id, { enabled: agent.enabled, mode: agent.mode, line: agent.line, prompt: agent.prompt }])), {
    build: { enabled: true, mode: "primary", line: "$free", prompt: { mode: "preserve-static" } },
    coder: { enabled: true, mode: "subagent", line: "$free", prompt: { mode: "preserve-static" } },
    reviewer: { enabled: true, mode: "subagent", line: "$free", prompt: { mode: "preserve-static" } }
  })
  assert.deepEqual(fleet.contextSources, {})
  assert.deepEqual(requireLine(config, "free").chain, [{ providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" }])
  assert.deepEqual([...fleet.linesByAgent.values()].map((line) => line.id), ["free", "free", "free"])
})

test("agent steps are positive, prompt policies match their shape, and enabled agents name a line", () => {
  const valid = { version: 1, id: "shape", name: "Shape", description: "x", defaultAgent: "build", agents: { build: { enabled: true, line: "$standard", steps: 1, prompt: { mode: "replace", paths: ["prompt.md"] } } }, contextSources: {} } as unknown as Fleet
  validateFleet(valid)
  assert.throws(() => validateFleet({ ...valid, agents: { build: { ...valid.agents.build, steps: 0 } } } as Fleet), /invalid steps/)
  assert.throws(() => validateFleet({ ...valid, agents: { build: { ...valid.agents.build, prompt: { mode: "preserve-static", paths: ["prompt.md"] } } } } as Fleet), /preserve-static prompt/)
  assert.throws(() => validateFleet({ ...valid, agents: { build: { ...valid.agents.build, prompt: { mode: "append", paths: [] } } } } as Fleet), /append prompt/)
  assert.throws(() => validateFleet({ ...valid, agents: { build: { enabled: true } } } as unknown as Fleet), /must name a line/)
  assert.throws(() => validateFleet({ ...valid, agents: { build: { enabled: true, line: "standard" } } } as unknown as Fleet), /must be a line reference/)
  assert.throws(() => validateFleet({ ...valid, agents: { build: { enabled: false, line: "$standard" } } } as unknown as Fleet), /cannot contain behavior configuration/)
})

test("validation rejects duplicate models, non-terminal OpenRouter, unknown lines, and inline lines", () => {
  const chain = [{ providerID: "a", modelID: "m" }, { providerID: "a", modelID: "m", variant: "other" }]
  assert.throws(() => validateChain(chain, "line"), /duplicate provider\/model/)
  assert.throws(() => validateChain([{ providerID: "openrouter", modelID: "one" }, { providerID: "a", modelID: "two" }], "line"), /after OpenRouter/)
  assert.throws(() => validateLine({ version: 1, id: "empty", name: "Empty", description: "x", chain: [] } as unknown as Line), /at least one model/)
  const fleet = { version: 1, id: "fleet", name: "Fleet", description: "x", defaultAgent: "build", agents: { build: { enabled: true, line: "$missing" } }, contextSources: {} } as unknown as Fleet
  assert.throws(() => validateFleet(fleet, undefined, new Set(["heavy"])), /references unknown line \$missing/)
  assert.throws(() => validateFleet({ ...fleet, agents: { build: { enabled: true, line: "$heavy" } } } as Fleet, undefined, new Set(["other"])), /references unknown line/)
  assert.doesNotThrow(() => validateFleet({ ...fleet, agents: { build: { enabled: true, line: "$heavy" } } } as Fleet, undefined, new Set(["heavy"])))
  assert.throws(() => validateFleet({ ...fleet, agents: { build: { enabled: true, line: "$known" } }, defaultLine: "$heavy" } as Fleet, undefined, new Set(["known"])), /defaultLine references unknown line/)
  assert.throws(() => validateFleet({ ...fleet, lines: { heavy: [] } } as unknown as Fleet), /shared line catalog/)
})

test("all fleets must explicitly declare the managed union", async () => {
  const root = await fixture(); await mkdir(join(root, "fleets/other"), { recursive: true })
  await writeFile(join(root, "fleets/other/fleet.json"), JSON.stringify({ version: 1, id: "other", name: "Other", description: "x", defaultAgent: "reviewer", agents: { reviewer: { enabled: true, line: "$free" } }, contextSources: {} }))
  await assert.rejects(loadConfig(root), /must explicitly enable or disable managed agent/)
})

test("path traversal and symlink escapes are rejected", async () => {
  const root = await fixture(); const value = await fleetDocument(root); value.contextSources["build-memory"].path = "../outside.md"; await saveFleet(root, value)
  await assert.rejects(loadConfig(root), /escapes/)
  const second = await fixture(); const outside = await mkdtemp(join(tmpdir(), "outside-")); await symlink(outside, join(second, "fleets/software-team/link")); const secondValue = await fleetDocument(second); secondValue.contextSources["build-memory"].path = "link/outside.md"; await saveFleet(second, secondValue)
  await assert.rejects(loadConfig(second), /symlink/)
})

test("state selection is deterministic, strict, atomic, and tracks fleet boundaries", async () => {
  const root = await fixture(); const config = await loadConfig(root); const statePath = join(root, "state/state.json")
  assert.deepEqual(await selectState(config, statePath), { version: 1, fleet: "free", fleetActivatedAt: 0 })
  const setupSnapshot = await compileSnapshot(root, join(root, "setup-state.json"), 300); const restartedSnapshot = await compileSnapshot(root, join(root, "setup-state.json"), 400)
  assert.equal(setupSnapshot.state.fleetActivatedAt, 300); assert.equal(restartedSnapshot.state.fleetActivatedAt, 300)
  const first = await writeState(config, "software-team", statePath, 100); const second = await writeState(config, "software-team", statePath, 200)
  assert.equal(second.fleetActivatedAt, first.fleetActivatedAt)
  const third = await writeState(config, "free", statePath, 300); assert.equal(third.fleetActivatedAt, 300)
  assert.equal((await readFile(statePath, "utf8")).includes('"fleet": "free"'), true)
  await writeFile(statePath, JSON.stringify({ version: 1, fleet: "missing", fleetActivatedAt: 1 })); await assert.rejects(selectState(config, statePath), /not present in configuration/)
  await writeFile(statePath, JSON.stringify({ version: 1, architecture: "software-team", fleet: "free", architectureActivatedAt: 1 })); await assert.rejects(selectState(config, statePath), /unsupported fields/)
})

test("an explicit selection replaces an unreadable prior state", async () => {
  const root = await fixture(); const config = await loadConfig(root); const statePath = join(root, "stale-state.json")
  await writeFile(statePath, JSON.stringify({ version: 1, architecture: "software-team", fleet: "free", architectureActivatedAt: 1 }))
  await assert.rejects(selectState(config, statePath), /unsupported fields/)
  const next = await writeState(config, "free", statePath, 42)
  assert.deepEqual(next, { version: 1, fleet: "free", fleetActivatedAt: 42 })
  assert.deepEqual(await selectState(config, statePath), next)
})

test("prompt policies and context enforce one snapshot and session boundary", async () => {
  const root = await fixture(); const statePath = join(root, "state.json"); await writeState(await loadConfig(root), "software-team", statePath, 100); const snapshot = await compileSnapshot(root, statePath)
  const agents = new Map<string, any>([["build", { id: "build", request: {}, mode: "primary", hidden: false, permissions: { execute: "ask" }, system: "static" }], ["coder", { id: "coder", request: {}, mode: "subagent", hidden: false, permissions: { execute: "ask" } }], ["reviewer", { id: "reviewer", request: {}, mode: "subagent", hidden: false, permissions: { execute: "ask" } }], ["unmanaged", { id: "unmanaged", request: {}, mode: "all", hidden: false, permissions: { execute: "ask" } }]])
  const draft: any = { get: (id: string) => agents.get(id), update: (id: string, fn: (agent: any) => void) => fn(agents.get(id)), remove: (id: string) => agents.delete(id), default: (id: string) => { draft.selected = id }, list: () => [...agents.values()] }
  applyAgentTransform(draft, snapshot); assert.equal(agents.get("build").system.startsWith("# Build agent"), true); assert.equal(agents.get("build").permissions.execute, "ask"); assert.equal(draft.selected, "build")
  assert.deepEqual(agents.get("build").model, { providerID: "openai", id: "gpt-5-codex" }); assert.deepEqual(agents.get("reviewer").model, { providerID: "google", id: "gemini-2.0-flash" })
  const old = { sessionID: "s", agent: "build", system: [] as any[] }; await assert.rejects(injectContext(old, snapshot, { get: async () => ({ time: { created: 99 } }) }), /predates/)
  const current = { sessionID: "s", agent: "build", system: [] as any[] }; await injectContext(current, snapshot, { get: async () => ({ time: { created: 100 } }) }); assert.equal(current.system.length, 1)
  const appendRoot = await fixture(); const appendValue = await fleetDocument(appendRoot); appendValue.agents.build.prompt = { mode: "append", paths: ["prompts/build.md"] }; await saveFleet(appendRoot, appendValue); const appendStatePath = join(appendRoot, "append-state.json"); await writeState(await loadConfig(appendRoot), "software-team", appendStatePath); const appendSnapshot = await compileSnapshot(appendRoot, appendStatePath); const appendAgent = new Map([["build", { id: "build", request: {}, mode: "primary", hidden: false, permissions: {}, system: "static system" }], ["coder", { id: "coder", request: {}, mode: "subagent", hidden: false, permissions: {} }], ["reviewer", { id: "reviewer", request: {}, mode: "subagent", hidden: false, permissions: {} }]]); const appendDraft: any = { get: (id: string) => appendAgent.get(id), update: (id: string, fn: (agent: any) => void) => fn(appendAgent.get(id)), remove: () => undefined, default: () => undefined }; applyAgentTransform(appendDraft, appendSnapshot); assert.match(appendAgent.get("build")!.system as string, /^static system\n\n# Build agent/)
})

test("plugin rejects missing enabled agents, removes disabled agents, and handles memory failures", async () => {
  const root = await fixture(); const snapshot = await compileSnapshot(root, join(root, "state.json"))
  const agents = new Map<string, any>([["build", { id: "build", request: {}, mode: "primary", hidden: false, permissions: {} }], ["coder", { id: "coder", request: {}, mode: "subagent", hidden: false, permissions: {} }], ["reviewer", { id: "reviewer", request: {}, mode: "subagent", hidden: false, permissions: {} }], ["unmanaged", { id: "unmanaged", request: {}, mode: "all", hidden: false, permissions: {} }]])
  const draft: any = { get: (id: string) => agents.get(id), update: (id: string, fn: (agent: any) => void) => fn(agents.get(id)), remove: (id: string) => agents.delete(id), default: () => undefined }
  applyAgentTransform(draft, snapshot); assert.equal(agents.has("unmanaged"), true)
  const missing = new Map(agents); missing.delete("reviewer"); assert.throws(() => applyAgentTransform({ ...draft, get: (id: string) => missing.get(id) }, snapshot), /missing enabled agent/)
  const disabledRoot = await fixture(); const disabledValue = await fleetDocument(disabledRoot); disabledValue.agents.coder = { enabled: false }; delete disabledValue.contextSources["coder-memory"]; await saveFleet(disabledRoot, disabledValue)
  const disabledStatePath = join(disabledRoot, "disabled-state.json"); await writeState(await loadConfig(disabledRoot), "software-team", disabledStatePath); const disabledSnapshot = await compileSnapshot(disabledRoot, disabledStatePath); const disabledAgents = new Map(agents); const disabledDraft: any = { get: (id: string) => disabledAgents.get(id), update: (id: string, fn: (agent: any) => void) => fn(disabledAgents.get(id)), remove: (id: string) => disabledAgents.delete(id), default: () => undefined }; applyAgentTransform(disabledDraft, disabledSnapshot); assert.equal(disabledAgents.has("coder"), false)
  const value = await fleetDocument(root); value.contextSources["reviewer-memory"].path = "memory/not-there.md"; value.contextSources["reviewer-memory"].required = true; await saveFleet(root, value)
  const requiredStatePath = join(root, "required-state.json"); await writeState(await loadConfig(root), "software-team", requiredStatePath); const requiredSnapshot = await compileSnapshot(root, requiredStatePath); await assert.rejects(injectContext({ sessionID: "s", agent: "reviewer", system: [] }, requiredSnapshot), /Required context source/)
  const optionalRoot = await fixture(); const optionalValue = await fleetDocument(optionalRoot); optionalValue.contextSources["reviewer-memory"].path = "memory/not-there.md"; optionalValue.contextSources["reviewer-memory"].required = false; await saveFleet(optionalRoot, optionalValue); const optionalStatePath = join(optionalRoot, "optional-state.json"); await writeState(await loadConfig(optionalRoot), "software-team", optionalStatePath); const optionalSnapshot = await compileSnapshot(optionalRoot, optionalStatePath); const optionalEvent = { sessionID: "s", agent: "reviewer", system: [] as any[] }; await injectContext(optionalEvent, optionalSnapshot); assert.equal(optionalEvent.system.length, 0)
  const outsideMemory = await mkdtemp(join(tmpdir(), "outside-memory-")); const laterPath = join(optionalRoot, "fleets/software-team/memory/later.md"); const laterEvent = { sessionID: "s", agent: "reviewer", system: [] as any[] }; optionalValue.contextSources["reviewer-memory"].path = "memory/later.md"; await saveFleet(optionalRoot, optionalValue); const laterStatePath = join(optionalRoot, "later-state.json"); await writeState(await loadConfig(optionalRoot), "software-team", laterStatePath); const laterSnapshot = await compileSnapshot(optionalRoot, laterStatePath); await writeFile(join(outsideMemory, "later.md"), "outside"); await symlink(join(outsideMemory, "later.md"), laterPath); await assert.rejects(injectContext(laterEvent, laterSnapshot), /containment validation/)
  const oversizeRoot = await fixture(); const oversizeValue = await fleetDocument(oversizeRoot); oversizeValue.contextSources["reviewer-memory"].maxBytes = 1; await saveFleet(oversizeRoot, oversizeValue); const oversizeStatePath = join(oversizeRoot, "oversize-state.json"); await writeState(await loadConfig(oversizeRoot), "software-team", oversizeStatePath); const oversizeSnapshot = await compileSnapshot(oversizeRoot, oversizeStatePath); await assert.rejects(injectContext({ sessionID: "s", agent: "reviewer", system: [] }, oversizeSnapshot), /exceeds/)
})

test("retry advances the agent line and falls back to the fleet default line", async () => {
  const root = await fixture(); const statePath = join(root, "missing-state.json"); const config = await loadConfig(root); await writeState(config, "software-team", statePath); const snapshot = await compileSnapshot(root, statePath)
  const event: any = { sessionID: "s", agent: "coder", model: { providerID: "unknown", modelID: "model" }, error: { status: 503 } }; let switched: any
  await handleRetry(event, snapshot, async (model) => { switched = model }); assert.equal(switched.providerID, "anthropic"); assert.deepEqual(event.decision, { retry: true, delay: 0 })
  const second: any = { sessionID: "s", agent: "coder", model: { providerID: "anthropic", modelID: "claude-sonnet-4" }, error: { status: 429 } }
  await handleRetry(second, snapshot, async (model) => { switched = model }); assert.equal(switched.modelID, "gemini-2.5-pro")
  const agentless: any = { sessionID: "s", model: { providerID: "openai", modelID: "gpt-5-codex" }, error: { status: 503 } }
  await handleRetry(agentless, snapshot, async (model) => { switched = model }); assert.equal(switched.modelID, "claude-sonnet-4")
  const terminal: any = { sessionID: "s", agent: "reviewer", model: { providerID: "openrouter", modelID: "google/gemini-2.0-flash" }, error: { status: 503 } }
  await handleRetry(terminal, snapshot, async () => { throw new Error("should not switch") }); assert.deepEqual(terminal.decision, { retry: false })
})

test("CLI colors, init no-overwrite, validate, list, lines, show, and use use a fake executable", async () => {
  assert.equal(colorsEnabled({ NO_COLOR: "1", FORCE_COLOR: "1" }, true), false); assert.equal(colorsEnabled({ FORCE_COLOR: "1" }, false), true); assert.equal(colorsEnabled({}, false), false)
  const root = await mkdtemp(join(tmpdir(), "agents-fleet-cli-")); const cli = fileURLToPath(new URL("../cli.js", import.meta.url)); const init = spawnSync(process.execPath, [cli, "init", root], { encoding: "utf8" }); assert.equal(init.status, 0, init.stderr)
  const initialized = await loadConfig(root)
  for (const fleetID of ["free", "software-team"]) {
    const fleetPath = join(root, `fleets/${fleetID}/fleet.json`); assert.equal(existsSync(resolve(dirname(fleetPath), JSON.parse(await readFile(fleetPath, "utf8")).$schema)), true)
  }
  for (const lineID of ["economy", "free", "frontier", "standard"]) {
    const linePath = join(root, `lines/${lineID}.json`); assert.equal(existsSync(resolve(dirname(linePath), JSON.parse(await readFile(linePath, "utf8")).$schema)), true)
  }
  assert.equal(initialized.lines.size, 4)
  const initializedFiles = ["fleets/free/fleet.json", "fleets/software-team/fleet.json", "lines/economy.json", "lines/free.json", "lines/frontier.json", "lines/standard.json"]
  const before = await Promise.all(initializedFiles.map((path) => readFile(join(root, path), "utf8")))
  const marker = join(root, "restart.txt"); const executable = join(root, "fake-opencode"); await writeFile(executable, `#!/bin/sh\necho restarted > '${marker}'\n`); await chmod(executable, 0o755)
  const env = { ...process.env, AGENTS_FLEET_HOME: root, XDG_STATE_HOME: join(root, "xdg-state"), OPENCODE_BIN: executable, NO_COLOR: "1" }
  const validate = spawnSync(process.execPath, [cli, "validate"], { env, encoding: "utf8" }); assert.equal(validate.status, 0, validate.stderr); assert.match(validate.stdout, /2 fleet\(s\), 4 line\(s\)/)
  const current = spawnSync(process.execPath, [cli, "current"], { env, encoding: "utf8" }); assert.equal(current.status, 0); assert.equal(current.stdout.trim(), "free")
  const showFleet = spawnSync(process.execPath, [cli, "show", "free"], { env, encoding: "utf8" }); assert.equal(showFleet.status, 0); assert.match(showFleet.stdout, /Fleet: free/); assert.match(showFleet.stdout, /\$free/); assert.match(showFleet.stdout, /opencode\/muse-spark-1\.3-contributor-free/)
  const showTeam = spawnSync(process.execPath, [cli, "show", "software-team"], { env, encoding: "utf8" }); assert.equal(showTeam.status, 0); assert.match(showTeam.stdout, /build \[primary\] \$frontier/); assert.match(showTeam.stdout, /memory\/build\.md/)
  const showLine = spawnSync(process.execPath, [cli, "show", "$frontier"], { env, encoding: "utf8" }); assert.equal(showLine.status, 0); assert.match(showLine.stdout, /Line: \$frontier/); assert.match(showLine.stdout, /Used by:\n  software-team: build/)
  const showUnknownLine = spawnSync(process.execPath, [cli, "show", "$nope"], { env, encoding: "utf8" }); assert.equal(showUnknownLine.status, 1); assert.match(showUnknownLine.stderr, /Unknown line/)
  const list = spawnSync(process.execPath, [cli, "list"], { env, encoding: "utf8" }); assert.match(list.stdout, /free \(active\)/); assert.match(list.stdout, /build -> \$free/); assert.match(list.stdout, /reviewer -> \$economy/); assert.equal(/\x1b\[/.test(list.stdout), false)
  const lines = spawnSync(process.execPath, [cli, "lines"], { env, encoding: "utf8" }); assert.match(lines.stdout, /\$frontier: openai\/gpt-5-codex -> anthropic\/claude-sonnet-4 -> openrouter\/openai\/gpt-5-codex/)
  const coloredEnv: NodeJS.ProcessEnv = { ...env, FORCE_COLOR: "1" }; delete coloredEnv.NO_COLOR
  const colored = spawnSync(process.execPath, [cli, "show", "$free"], { env: coloredEnv, encoding: "utf8" }); assert.match(colored.stdout, /\x1b\[34m\$free\x1b\[0m/); assert.match(colored.stdout, /\x1b\[32mopencode\/muse-spark-1\.3-contributor-free\x1b\[0m/)
  const use = spawnSync(process.execPath, [cli, "use", "software-team", "--no-restart"], { env, encoding: "utf8" }); assert.equal(use.status, 0, use.stderr); assert.match(use.stdout, /Active fleet: software-team/); assert.match(await readFile(join(root, "xdg-state/agents-fleet/state.json"), "utf8"), /"fleet": "software-team"/)
  const useRestart = spawnSync(process.execPath, [cli, "use", "free"], { env, encoding: "utf8" }); assert.equal(useRestart.status, 0, useRestart.stderr); assert.equal((await readFile(marker, "utf8")).trim(), "restarted")
  const again = spawnSync(process.execPath, [cli, "init", root], { encoding: "utf8" }); assert.equal(again.status, 0); const after = await Promise.all(initializedFiles.map((path) => readFile(join(root, path), "utf8"))); assert.deepEqual(after, before)
})
