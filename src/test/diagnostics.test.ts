import { test } from "node:test"
import assert from "node:assert/strict"
import { chmod, cp, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { doctorExitCode, runDiagnostics } from "../diagnostics.js"

const example = fileURLToPath(new URL("../../examples/software-team", import.meta.url))

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agents-fleet-doctor-"))
  await cp(example, root, { recursive: true })
  return root
}

async function fakeOpenCode(root: string, body: string): Promise<string> {
  const executable = join(root, "fake-opencode")
  await writeFile(executable, `#!/bin/sh\n${body}\n`)
  await chmod(executable, 0o755)
  return executable
}

async function catalogOpenCode(root: string, values: { agents?: unknown[]; models?: unknown[]; providers?: unknown[]; version?: string }): Promise<string> {
  const agents = JSON.stringify({ location: { directory: "/workspace" }, data: values.agents ?? [{ id: "build" }, { id: "coder" }, { id: "reviewer" }] })
  const models = JSON.stringify({ location: { directory: "/workspace" }, data: values.models ?? [{ providerID: "opencode", modelID: "muse-spark-1.3-contributor-free", variants: [] }] })
  const providers = JSON.stringify({ location: { directory: "/workspace" }, data: values.providers ?? [{ id: "opencode" }] })
  return fakeOpenCode(root, `
case "$1:$2" in
  --version:) echo '${values.version ?? "opencode v2.0.0"}';;
  api:agent.list) echo '${agents}' ;;
  api:model.list) echo '${models}' ;;
  api:provider.list) echo '${providers}' ;;
esac`)
}

function env(executable: string): NodeJS.ProcessEnv {
  return { ...process.env, OPENCODE_BIN: executable }
}

test("healthy offline diagnostics never touch OpenCode or create state", async () => {
  const root = await fixture()
  const marker = join(root, "poisoned")
  const executable = await fakeOpenCode(root, `echo touched > '${marker}'`)
  const state = join(root, "missing-state.json")
  const report = await runDiagnostics({ configRoot: root, statePath: state, offline: true, env: env(executable) })
  assert.equal(doctorExitCode(report), 0)
  assert.equal(report.ok, true)
  assert.deepEqual(report.selection, { architecture: "free", fleet: "free" })
  assert.equal(report.diagnostics.some((item) => item.severity === "skipped"), true)
  assert.equal(existsSync(marker), false)
  assert.equal(existsSync(state), false)
  assert.equal(JSON.stringify(report).includes(root), false)
})

test("configuration failures redact the local configuration root", async () => {
  const root = await fixture()
  await writeFile(join(root, "architectures/free/architecture.json"), "{")
  const report = await runDiagnostics({ configRoot: root, statePath: join(root, "state.json"), offline: true })
  assert.equal(doctorExitCode(report), 1)
  assert.equal(JSON.stringify(report).includes(root), false)
  assert.match(report.diagnostics[0].message, /<config>/)
})

test("state errors and missing state selection are deterministic", async () => {
  const root = await fixture()
  const state = join(root, "state.json")
  await writeFile(state, "not json")
  const invalid = await runDiagnostics({ configRoot: root, statePath: state, offline: true })
  assert.equal(doctorExitCode(invalid), 1)
  assert.equal(invalid.diagnostics.some((item) => item.code === "STATE_INVALID"), true)
  await writeFile(state, JSON.stringify({ version: 1, architecture: "missing", fleet: "free", architectureActivatedAt: 0 }))
  const missing = await runDiagnostics({ configRoot: root, statePath: state, offline: true })
  assert.equal(doctorExitCode(missing), 1)
  assert.equal(missing.diagnostics.some((item) => item.code === "STATE_SELECTION_INVALID"), true)
  await writeFile(state, "{}")
  const absent = await runDiagnostics({ configRoot: root, statePath: join(root, "absent.json"), offline: true })
  assert.deepEqual(absent.selection, { architecture: "free", fleet: "free" })
})

test("offline diagnostics report independent fleet, context, and schema issues", async () => {
  const root = await fixture()
  const budget = join(root, "architectures/software-team/fleets/budget.json")
  const balanced = join(root, "architectures/software-team/fleets/balanced.json")
  await writeFile(budget, "{}")
  await writeFile(balanced, "[]")
  const architecturePath = join(root, "architectures/software-team/architecture.json")
  const architecture = JSON.parse(await readFile(architecturePath, "utf8")) as any
  architecture.$schema = "missing-architecture-schema.json"
  architecture.contextSources["build-memory"] = { ...architecture.contextSources["build-memory"], required: true, path: "memory/required-not-found.md" }
  architecture.contextSources["coder-memory"] = { ...architecture.contextSources["coder-memory"], required: false, path: "memory/optional-not-found.md" }
  architecture.contextSources["reviewer-memory"] = { ...architecture.contextSources["reviewer-memory"], maxBytes: 1 }
  await writeFile(architecturePath, JSON.stringify(architecture))
  const report = await runDiagnostics({ configRoot: root, statePath: join(root, "state.json"), offline: true })
  assert.equal(doctorExitCode(report), 1)
  assert.equal(report.diagnostics.filter((item) => item.code === "FLEET_INVALID").length, 2)
  assert.equal(report.diagnostics.some((item) => item.code === "CONTEXT_REQUIRED_MISSING"), true)
  assert.equal(report.diagnostics.some((item) => item.code === "CONTEXT_OPTIONAL_MISSING"), true)
  assert.equal(report.diagnostics.some((item) => item.code === "CONTEXT_OVERSIZE"), true)
  assert.equal(report.diagnostics.some((item) => item.code === "SCHEMA_REF_UNRESOLVED"), true)
})

test("successful V2 probes use normalized catalogs and do not expose raw records", async () => {
  const root = await fixture()
  const executable = await fakeOpenCode(root, `
case "$1:$2" in
  --version:) echo 'OpenCode V2 2.0.0';;
  api:agent.list) echo '{"location":"/agents","data":[{"id":"build"},{"id":"coder"},{"id":"reviewer"}]}' ;;
  api:model.list) echo '{"location":"/models","data":[{"providerID":"opencode","modelID":"muse-spark-1.3-contributor-free","settings":"do-not-report"}]}' ;;
  api:provider.list) echo '{"location":"/providers","data":[{"id":"opencode","headers":"do-not-report"}]}' ;;
esac`)
  const report = await runDiagnostics({ configRoot: root, statePath: join(root, "state.json"), env: env(executable) })
  assert.equal(doctorExitCode(report), 0)
  assert.equal(report.complete, true)
  assert.equal(report.opencodeVersion, "2.0.0")
  assert.equal(JSON.stringify(report).includes("do-not-report"), false)
  assert.equal(report.diagnostics.some((item) => item.code === "PROVIDER_MISSING" && item.severity === "warning"), true)
  assert.equal(report.summary.error, 0)
})

test("selected catalog incompatibilities are errors and inactive gaps stay warnings", async () => {
  const agentRoot = await fixture()
  const agentExecutable = await catalogOpenCode(agentRoot, { agents: [{ id: "build" }, { id: "coder" }] })
  const agentReport = await runDiagnostics({ configRoot: agentRoot, statePath: join(agentRoot, "state.json"), env: env(agentExecutable) })
  assert.equal(doctorExitCode(agentReport), 1)
  assert.equal(agentReport.diagnostics.some((item) => item.code === "AGENT_MISSING" && item.severity === "error"), true)

  const providerRoot = await fixture()
  const providerExecutable = await catalogOpenCode(providerRoot, { providers: [] })
  const providerReport = await runDiagnostics({ configRoot: providerRoot, statePath: join(providerRoot, "state.json"), env: env(providerExecutable) })
  assert.equal(doctorExitCode(providerReport), 1)
  assert.equal(providerReport.diagnostics.some((item) => item.code === "PROVIDER_MISSING" && item.severity === "error"), true)
  assert.equal(providerReport.diagnostics.some((item) => item.code === "MODEL_MISSING" && item.severity === "error"), false)

  const modelRoot = await fixture()
  const modelExecutable = await catalogOpenCode(modelRoot, { models: [] })
  const modelReport = await runDiagnostics({ configRoot: modelRoot, statePath: join(modelRoot, "state.json"), env: env(modelExecutable) })
  assert.equal(doctorExitCode(modelReport), 1)
  assert.equal(modelReport.diagnostics.some((item) => item.code === "MODEL_MISSING" && item.severity === "error"), true)

  const variantRoot = await fixture()
  const fleetPath = join(variantRoot, "architectures/free/fleets/free.json")
  const fleet = JSON.parse(await readFile(fleetPath, "utf8")) as any
  fleet.chains.all[0].variant = "high"
  fleet.defaultChain[0].variant = "high"
  await writeFile(fleetPath, JSON.stringify(fleet))
  const variantExecutable = await catalogOpenCode(variantRoot, { models: [{ providerID: "opencode", modelID: "muse-spark-1.3-contributor-free", variants: [{ id: "low" }] }] })
  const variantReport = await runDiagnostics({ configRoot: variantRoot, statePath: join(variantRoot, "state.json"), env: env(variantExecutable) })
  assert.equal(doctorExitCode(variantReport), 1)
  assert.equal(variantReport.diagnostics.some((item) => item.code === "VARIANT_MISSING" && item.severity === "error"), true)
})

test("missing executable and incomplete probes have exit code two", async () => {
  const root = await fixture()
  const missing = await runDiagnostics({ configRoot: root, statePath: join(root, "state.json"), env: env(join(root, "does-not-exist")) })
  assert.equal(doctorExitCode(missing), 2)
  const executable = await fakeOpenCode(root, `
case "$1:$2" in
  --version:) echo 'OpenCode V2 2.0.0';;
  api:agent.list) echo 'partial';;
  *) echo '{"location":"/ok","data":[]}' ;;
esac`)
  const malformed = await runDiagnostics({ configRoot: root, statePath: join(root, "state.json"), env: env(executable) })
  assert.equal(doctorExitCode(malformed), 2)
  assert.equal(malformed.diagnostics.some((item) => item.code === "OPENCODE_PROBES_INCOMPLETE"), true)

  const nonzeroRoot = await fixture()
  const nonzeroExecutable = await fakeOpenCode(nonzeroRoot, `
case "$1:$2" in
  --version:) echo 'opencode v2.0.0';;
  api:model.list) exit 9;;
  *) echo '{"location":"/ok","data":[]}' ;;
esac`)
  const nonzero = await runDiagnostics({ configRoot: nonzeroRoot, statePath: join(nonzeroRoot, "state.json"), env: env(nonzeroExecutable) })
  assert.equal(doctorExitCode(nonzero), 2)

  const recordRoot = await fixture()
  const sensitive = "sensitive-header-value"
  const recordExecutable = await fakeOpenCode(recordRoot, `
case "$1:$2" in
  --version:) echo 'opencode v2.0.0';;
  api:model.list) echo '{"location":"/models","data":[{"headers":"${sensitive}"}]}' ;;
  *) echo '{"location":"/ok","data":[]}' ;;
esac`)
  const record = await runDiagnostics({ configRoot: recordRoot, statePath: join(recordRoot, "state.json"), env: env(recordExecutable) })
  assert.equal(doctorExitCode(record), 2)
  assert.equal(JSON.stringify(record).includes(sensitive), false)
})

test("doctor CLI supports human, JSON, offline, help, and exit codes", async () => {
  const root = await fixture()
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url))
  const envValue = { ...process.env, NO_COLOR: "1", OPENCODE_BIN: join(root, "never-run") }
  const offline = spawnSync(process.execPath, [cli, "doctor", root, "--offline", "--state", join(root, "state.json")], { encoding: "utf8", env: envValue })
  assert.equal(offline.status, 0, offline.stderr)
  assert.match(offline.stdout, /Doctor: OK/)
  assert.match(offline.stdout, /Summary:/)
  const positional = spawnSync(process.execPath, [cli, "doctor", root, "--offline", "--state", join(root, "state.json")], { encoding: "utf8", env: { ...envValue, AGENTS_FLEET_HOME: "relative-is-ignored" } })
  assert.equal(positional.status, 0, positional.stderr)
  const json = spawnSync(process.execPath, [cli, "doctor", root, "--offline", "--json", "--state", join(root, "state.json")], { encoding: "utf8", env: envValue })
  assert.equal(json.status, 0, json.stderr)
  assert.equal(JSON.parse(json.stdout).version, 1)
  const invalidState = join(root, "invalid-state.json"); await writeFile(invalidState, "not json")
  const failed = spawnSync(process.execPath, [cli, "doctor", root, "--offline", "--json", "--state", invalidState], { encoding: "utf8", env: envValue })
  assert.equal(failed.status, 1); assert.equal(JSON.parse(failed.stdout).complete, true)
  const incomplete = spawnSync(process.execPath, [cli, "doctor", root, "--json", "--state", join(root, "absent-state.json")], { encoding: "utf8", env: envValue })
  assert.equal(incomplete.status, 2); assert.equal(JSON.parse(incomplete.stdout).complete, false)
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /doctor \[directory\]/)
})
