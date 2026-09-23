#!/usr/bin/env node
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { configRoot } from "./paths.js"
import { loadConfig, requireFleet, requireLine } from "./loader.js"
import { selectState, writeState } from "./state.js"
import { doctorExitCode, runDiagnostics, validateOpenCodeExecutable } from "./diagnostics.js"
import { assertID, lineID } from "./validation.js"
import type { Line, LoadedConfig, ModelRef, ResolvedFleet } from "./types.js"

const HELP = `Usage: agents-fleet <command> [options]

Commands:
  init [directory]                         Copy the generic example without overwriting
  validate [directory]                     Validate every fleet and line file
  current                                  Print the active fleet
  list                                     List fleets with the lines their agents bind
  lines                                    List the shared line catalog
  show <fleet|$line>                       Show fleet or line details
  use <fleet> [--no-restart]               Persist the fleet selection and restart OpenCode
  doctor [directory] [--offline] [--json]  Diagnose configuration and OpenCode catalogs

Options:
  --config <directory>                     Configuration root override
  --state <file>                           State file override (for testing or isolation)
  --no-restart                             Do not restart after use
  --offline                                Skip OpenCode subprocess checks (doctor)
  --json                                   Emit one JSON doctor report (doctor)
`

const ANSI = { reset: "\x1b[0m", magenta: "\x1b[35m", blue: "\x1b[34m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", dim: "\x1b[2m" }
export function colorsEnabled(env: NodeJS.ProcessEnv = process.env, isTTY = Boolean(process.stdout.isTTY)): boolean {
  if (env.NO_COLOR !== undefined) return false
  if (env.FORCE_COLOR === "1") return true
  if (env.FORCE_COLOR === "0") return false
  return isTTY
}
function color(value: string, style: string, enabled: boolean): string { return enabled ? `${style}${value}${ANSI.reset}` : value }
function modelLabel(model: ModelRef): string { return `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}` }
function routeLabel(models: readonly ModelRef[], enabled: boolean): string {
  return models.map((model, index) => color(modelLabel(model), index === 0 ? ANSI.green : ANSI.yellow, enabled)).join(color(" -> ", ANSI.dim, enabled))
}
function lineLabel(reference: string, enabled: boolean): string { return color(reference, ANSI.blue, enabled) }
function optionArgs(args: string[]): { args: string[]; config?: string; state?: string; noRestart: boolean; offline: boolean; json: boolean } {
  const positional: string[] = []; let config: string | undefined; let state: string | undefined; let noRestart = false; let offline = false; let json = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--no-restart") { noRestart = true; continue }
    if (arg === "--offline") { offline = true; continue }
    if (arg === "--json") { json = true; continue }
    if (arg === "--config" || arg === "--state") {
      const value = args[++index]
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`)
      if (arg === "--config") config = value; else state = value
      continue
    }
    if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`)
    positional.push(arg)
  }
  return { args: positional, config, state, noRestart, offline, json }
}
async function existing(path: string): Promise<boolean> { try { await stat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error } }
async function copyWithoutOverwrite(from: string, to: string): Promise<void> {
  const source = await stat(from)
  if (source.isDirectory()) {
    await mkdir(to, { recursive: true })
    for (const entry of await readdir(from, { withFileTypes: true })) await copyWithoutOverwrite(join(from, entry.name), join(to, entry.name))
    return
  }
  if (await existing(to)) { console.log(`skip ${to} (already exists)`); return }
  await cp(from, to)
  console.log(`created ${to}`)
}
type SchemaTarget = { target: string; schema: string }
async function discoverSchemaTargets(bundle: string, target: string): Promise<SchemaTarget[]> {
  const targets: SchemaTarget[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name)
      const destination = join(target, relative(bundle, source))
      if (entry.isDirectory()) { await visit(source); continue }
      if (!entry.name.endsWith(".json")) continue
      const schema = entry.name === "fleet.json" ? "fleet-v1.schema.json" : basename(directory) === "lines" ? "line-v1.schema.json" : undefined
      if (schema) targets.push({ target: destination, schema: relative(dirname(destination), join(target, "schemas", schema)).split(sep).join("/") })
    }
  }
  await visit(bundle)
  return targets
}
async function init(directory: string): Promise<void> {
  const target = resolve(directory)
  const bundle = resolve(dirname(fileURLToPath(import.meta.url)), "..", "examples", "software-team")
  const schemaBundle = resolve(dirname(fileURLToPath(import.meta.url)), "..", "schemas")
  if (!(await existing(bundle))) throw new Error("Bundled software-team example is unavailable")
  if (!(await existing(schemaBundle))) throw new Error("Bundled JSON schemas are unavailable")
  await mkdir(target, { recursive: true })
  const schemaTargets = await discoverSchemaTargets(bundle, target)
  const hadTargets = await Promise.all(schemaTargets.map((item) => existing(item.target)))
  for (const entry of await readdir(bundle, { withFileTypes: true })) await copyWithoutOverwrite(join(bundle, entry.name), join(target, entry.name))
  await copyWithoutOverwrite(schemaBundle, join(target, "schemas"))
  for (let index = 0; index < schemaTargets.length; index += 1) if (!hadTargets[index]) {
    const item = schemaTargets[index]
    const document = JSON.parse(await readFile(item.target, "utf8")) as Record<string, unknown>
    document.$schema = item.schema
    await writeFile(item.target, `${JSON.stringify(document, null, 2)}\n`)
  }
}
function chainOf(fleet: ResolvedFleet, agentID: string): readonly ModelRef[] | undefined {
  return fleet.linesByAgent.get(agentID)?.chain
}
function lineUsage(config: LoadedConfig, id: string): string[] {
  const usage: string[] = []
  for (const fleet of [...config.fleets.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    const agents = [...fleet.linesByAgent].filter(([, line]) => line.id === id).map(([agentID]) => agentID).sort()
    if (agents.length) usage.push(`${fleet.id}: ${agents.join(", ")}`)
  }
  return usage
}
function showFleet(fleet: ResolvedFleet, activeFleet: string, enabled: boolean): void {
  console.log(`Fleet${color(": ", ANSI.dim, enabled)}${color(fleet.id, ANSI.magenta, enabled)}${fleet.id === activeFleet ? " (active)" : ""}`)
  console.log(fleet.description)
  console.log("Agents:")
  for (const [id, spec] of Object.entries(fleet.agents)) {
    if (!spec.enabled) { console.log(`  ${color(id, ANSI.cyan, enabled)} (disabled)`); continue }
    const reference = spec.line ?? "?"
    const chain = chainOf(fleet, id)
    console.log(`  ${color(id, ANSI.cyan, enabled)}${color(" [", ANSI.dim, enabled)}${spec.mode ?? "preserve-static"}${color("] ", ANSI.dim, enabled)}${lineLabel(reference, enabled)}${chain ? color(": ", ANSI.dim, enabled) + routeLabel(chain, enabled) : ""}`)
  }
  const sources = Object.entries(fleet.contextSources)
  if (sources.length) {
    console.log("Context sources:")
    for (const [id, source] of sources) console.log(`  ${color(id, ANSI.cyan, enabled)}${color(": ", ANSI.dim, enabled)}${source.relativePath} (${source.required ? "required" : "optional"}, max ${source.maxBytes} bytes)`)
  }
  console.log(`Default agent${color(": ", ANSI.dim, enabled)}${fleet.defaultAgent}`)
  if (fleet.defaultLine) console.log(`Default line${color(": ", ANSI.dim, enabled)}${lineLabel(`$${fleet.defaultLine.id}`, enabled)}`)
}
function showLine(config: LoadedConfig, line: Line, enabled: boolean): void {
  console.log(`Line${color(": ", ANSI.dim, enabled)}${lineLabel(`$${line.id}`, enabled)}`)
  console.log(line.description)
  console.log("Chain:")
  console.log(`  ${routeLabel(line.chain, enabled)}`)
  const usage = lineUsage(config, line.id)
  console.log("Used by:")
  if (usage.length) for (const item of usage) console.log(`  ${item}`)
  else console.log("  (no fleet agent binds this line)")
}
function restart(): void {
  const executable = validateOpenCodeExecutable()
  const result = spawnSync(executable, ["service", "restart"], { stdio: "inherit", shell: false })
  if (result.error) throw new Error(`OpenCode restart failed: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`OpenCode restart failed with exit status ${result.status ?? "unknown"}`)
}

export async function run(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? "help"
  const parsed = optionArgs(argv.slice(1))
  if (["help", "--help", "-h"].includes(command)) { if (parsed.args.length) throw new Error("help does not accept arguments"); process.stdout.write(HELP); return }
  if (command === "init") { if (parsed.args.length > 1) throw new Error("init accepts at most one directory"); await init(parsed.args[0] ?? configRoot(parsed.config)); return }
  if (command === "doctor") {
    if (parsed.args.length > 1) throw new Error("doctor accepts at most one directory")
    const report = await runDiagnostics({ configRoot: parsed.args[0] ?? configRoot(parsed.config), statePath: parsed.state, offline: parsed.offline })
    if (parsed.json) process.stdout.write(`${JSON.stringify(report)}\n`)
    else {
      console.log(`Doctor: ${report.complete ? (report.ok ? "OK" : "ERRORS") : "INCOMPLETE"}`)
      if (report.selection) console.log(`Selection: ${report.selection.fleet}`)
      for (const item of report.diagnostics) {
        console.log(`[${item.severity}] ${item.code}${item.location ? ` (${item.location})` : ""}: ${item.message}`)
        if (item.hint) console.log(`  hint: ${item.hint}`)
      }
      console.log(`Summary: ${report.summary.error} error(s), ${report.summary.warning} warning(s), ${report.summary.info} info, ${report.summary.skipped} skipped.`)
    }
    process.exitCode = doctorExitCode(report)
    return
  }
  if (command === "validate") {
    if (parsed.args.length > 1) throw new Error("validate accepts at most one directory")
    const config = await loadConfig(parsed.args[0] ?? configRoot(parsed.config))
    console.log(`Valid configuration: ${config.fleets.size} fleet(s), ${config.lines.size} line(s)`); return
  }
  const config = await loadConfig(configRoot(parsed.config))
  if (command === "lines") {
    if (parsed.args.length) throw new Error("lines does not accept arguments")
    for (const line of [...config.lines.values()].sort((left, right) => left.id.localeCompare(right.id))) console.log(`${lineLabel(`$${line.id}`, colorsEnabled())}${color(": ", ANSI.dim, colorsEnabled())}${routeLabel(line.chain, colorsEnabled())}`)
    return
  }
  if (command === "use") {
    if (parsed.args.length !== 1) throw new Error("use requires exactly one fleet ID")
    const fleet = requireFleet(config, parsed.args[0])
    const next = await writeState(config, fleet.id, parsed.state)
    if (parsed.noRestart) { console.log(`Active fleet: ${next.fleet}; service restart skipped.`); return }
    try { restart() } catch (error) { throw new Error(`Fleet ${next.fleet} was saved, but the running service may be stale: ${error instanceof Error ? error.message : String(error)}`) }
    console.log(`Active fleet: ${next.fleet}`); return
  }
  const active = (await selectState(config, parsed.state)).fleet
  if (command === "current") { if (parsed.args.length) throw new Error("current does not accept arguments"); console.log(active); return }
  if (command === "list") {
    if (parsed.args.length) throw new Error("list does not accept arguments")
    const enabled = colorsEnabled()
    for (const fleet of [...config.fleets.values()].sort((left, right) => left.id.localeCompare(right.id))) {
      console.log(`${color(fleet.id, ANSI.magenta, enabled)}${fleet.id === active ? " (active)" : ""}`)
      for (const [agentID, line] of fleet.linesByAgent) console.log(`  ${color(agentID, ANSI.cyan, enabled)}${color(" -> ", ANSI.dim, enabled)}${lineLabel(`$${line.id}`, enabled)}`)
    }
    return
  }
  if (command === "show") {
    if (parsed.args.length !== 1) throw new Error("show requires exactly one fleet ID or $line reference")
    const value = parsed.args[0]
    const enabled = colorsEnabled()
    if (value.startsWith("$")) { showLine(config, requireLine(config, lineID(value)), enabled); return }
    assertID(value, "Fleet selector"); showFleet(requireFleet(config, value), active, enabled); return
  }
  throw new Error(`Unknown command "${command}"\n${HELP}`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) run().catch((error) => { console.error(`agents-fleet: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 })
