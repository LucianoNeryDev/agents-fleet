#!/usr/bin/env node
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { configRoot } from "./paths.js"
import { loadAllFleets, loadConfig, loadFleet } from "./loader.js"
import { compileSnapshot } from "./runtime.js"
import { selectState, writeState } from "./state.js"
import type { Fleet, LoadedConfig, ResolvedArchitecture } from "./types.js"

const HELP = `Usage: agents-fleet <command> [options]

Commands:
  init [directory]                         Copy the generic example without overwriting
  validate [directory]                     Validate all architecture and fleet files
  current                                  Print architecture/fleet
  list [architecture]                     List architectures and nested fleets
  show <architecture|fleet|architecture/fleet>  Show configuration details
  use <fleet|architecture/fleet> [--no-restart]  Persist selection and restart OpenCode

Options:
  --config <directory>                     Configuration root override
  --state <file>                           State file override (for testing or isolation)
  --no-restart                             Do not restart after use
`

const ANSI = { reset: "\x1b[0m", magenta: "\x1b[35m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", dim: "\x1b[2m" }
export function colorsEnabled(env: NodeJS.ProcessEnv = process.env, isTTY = Boolean(process.stdout.isTTY)): boolean {
  if (env.NO_COLOR !== undefined) return false
  if (env.FORCE_COLOR === "1") return true
  if (env.FORCE_COLOR === "0") return false
  return isTTY
}
function color(value: string, style: string, enabled: boolean): string { return enabled ? `${style}${value}${ANSI.reset}` : value }
function modelLabel(model: { providerID: string; modelID: string; variant?: string }): string { return `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}` }
function routeLabel(models: readonly { providerID: string; modelID: string; variant?: string }[], enabled: boolean): string {
  return models.map((model, index) => color(modelLabel(model), index === 0 ? ANSI.green : ANSI.yellow, enabled)).join(color(" -> ", ANSI.dim, enabled))
}
function selector(value: string, activeArchitecture: string): { architecture: string; fleet: string } {
  const parts = value.split("/")
  if (parts.length > 2 || parts.some((part) => !part)) throw new Error(`Invalid selector "${value}"; expected fleet or architecture/fleet`)
  return { architecture: parts.length === 2 ? parts[0] : activeArchitecture, fleet: parts.length === 2 ? parts[1] : parts[0] }
}
function optionArgs(args: string[]): { args: string[]; config?: string; state?: string; noRestart: boolean } {
  const positional: string[] = []; let config: string | undefined; let state: string | undefined; let noRestart = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--no-restart") { noRestart = true; continue }
    if (arg === "--config" || arg === "--state") {
      const value = args[++index]
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`)
      if (arg === "--config") config = value; else state = value
      continue
    }
    if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`)
    positional.push(arg)
  }
  return { args: positional, config, state, noRestart }
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
async function init(directory: string): Promise<void> {
  const target = resolve(directory)
  const bundle = resolve(dirname(fileURLToPath(import.meta.url)), "..", "examples", "software-team")
  const schemaBundle = resolve(dirname(fileURLToPath(import.meta.url)), "..", "schemas")
  if (!(await existing(bundle))) throw new Error("Bundled software-team example is unavailable")
  if (!(await existing(schemaBundle))) throw new Error("Bundled JSON schemas are unavailable")
  await mkdir(target, { recursive: true })
  const architectureTarget = join(target, "architectures/software-team/architecture.json")
  const fleetTargets = ["balanced", "budget"].map((id) => join(target, `architectures/software-team/fleets/${id}.json`))
  const hadArchitecture = await existing(architectureTarget)
  const hadFleets = await Promise.all(fleetTargets.map(existing))
  for (const entry of await readdir(bundle, { withFileTypes: true })) await copyWithoutOverwrite(join(bundle, entry.name), join(target, entry.name))
  await copyWithoutOverwrite(schemaBundle, join(target, "schemas"))
  if (!hadArchitecture) {
    const document = JSON.parse(await readFile(architectureTarget, "utf8")) as Record<string, unknown>
    document.$schema = "../../schemas/architecture-v1.schema.json"
    await writeFile(architectureTarget, `${JSON.stringify(document, null, 2)}\n`)
  }
  for (let index = 0; index < fleetTargets.length; index += 1) if (!hadFleets[index]) {
    const document = JSON.parse(await readFile(fleetTargets[index], "utf8")) as Record<string, unknown>
    document.$schema = "../../../schemas/fleet-v1.schema.json"
    await writeFile(fleetTargets[index], `${JSON.stringify(document, null, 2)}\n`)
  }
}
async function architectureFor(config: LoadedConfig, id: string): Promise<ResolvedArchitecture> {
  const architecture = config.architectures.get(id)
  if (!architecture) throw new Error(`Unknown architecture "${id}"`)
  return architecture
}
async function showArchitecture(config: LoadedConfig, architecture: ResolvedArchitecture, active: { architecture: string; fleet: string }, enabled: boolean): Promise<void> {
  const fleets = await loadAllFleets(config, architecture.id)
  console.log(`Architecture${color(": ", ANSI.dim, enabled)}${color(architecture.id, ANSI.magenta, enabled)}`)
  console.log(architecture.description)
  console.log("Fleets:")
  for (const id of fleets.keys()) console.log(`  ${color(id, ANSI.magenta, enabled)}${active.architecture === architecture.id && active.fleet === id ? " (active)" : ""}`)
  console.log("Agents:")
  for (const [id, spec] of Object.entries(architecture.agents)) console.log(`  ${color(id, ANSI.cyan, enabled)}${spec.enabled ? ` [${spec.routeSlot}]` : " (disabled)"}`)
}
async function showFleet(config: LoadedConfig, architecture: ResolvedArchitecture, fleet: Fleet, active: { architecture: string; fleet: string }, enabled: boolean): Promise<void> {
  console.log(`Architecture${color(": ", ANSI.dim, enabled)}${color(architecture.id, ANSI.magenta, enabled)}`)
  console.log(`Fleet${color(": ", ANSI.dim, enabled)}${color(fleet.id, ANSI.magenta, enabled)}${active.architecture === architecture.id && active.fleet === fleet.id ? " (active)" : ""}`)
  console.log(fleet.description)
  for (const [slot, chain] of Object.entries(fleet.chains)) console.log(`${color(slot, ANSI.cyan, enabled)}${color(": ", ANSI.dim, enabled)}${routeLabel(chain, enabled)}`)
  if (fleet.defaultChain) console.log(`${color("(default)", ANSI.cyan, enabled)}${color(": ", ANSI.dim, enabled)}${routeLabel(fleet.defaultChain, enabled)}`)
}
function restart(): void {
  const executable = process.env.OPENCODE_BIN || "opencode"
  if (!executable || /[\0\s]/.test(executable) || executable.startsWith("-")) throw new Error("OPENCODE_BIN must be one executable path/name, not a shell command")
  const result = spawnSync(executable, ["service", "restart"], { stdio: "inherit", shell: false })
  if (result.error) throw new Error(`OpenCode restart failed: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`OpenCode restart failed with exit status ${result.status ?? "unknown"}`)
}

export async function run(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? "help"
  const parsed = optionArgs(argv.slice(1))
  if (["help", "--help", "-h"].includes(command)) { if (parsed.args.length) throw new Error("help does not accept arguments"); process.stdout.write(HELP); return }
  if (command === "init") { if (parsed.args.length > 1) throw new Error("init accepts at most one directory"); await init(parsed.args[0] ?? configRoot(parsed.config)); return }
  const root = configRoot(parsed.config)
  if (command === "validate") {
    if (parsed.args.length > 1) throw new Error("validate accepts at most one directory")
    const config = await loadConfig(parsed.args[0] ?? root)
    for (const id of config.architectures.keys()) await loadAllFleets(config, id)
    console.log(`Valid configuration: ${config.architectures.size} architecture(s)`); return
  }
  const config = await loadConfig(root); const state = await selectState(config, parsed.state); const active = { architecture: state.architecture, fleet: state.fleet }
  if (command === "current") { if (parsed.args.length) throw new Error("current does not accept arguments"); console.log(`${active.architecture}/${active.fleet}`); return }
  if (command === "list") {
    if (parsed.args.length > 1) throw new Error("list accepts at most one architecture")
    const architectures = parsed.args[0] ? [await architectureFor(config, parsed.args[0])] : [...config.architectures.values()]
    for (const architecture of architectures) { console.log(`${color(architecture.id, ANSI.magenta, colorsEnabled())}${architecture.id === active.architecture ? " (active)" : ""}`); for (const fleet of (await loadAllFleets(config, architecture.id)).keys()) console.log(`  ${color(fleet, ANSI.magenta, colorsEnabled())}${architecture.id === active.architecture && fleet === active.fleet ? " (active)" : ""}`) }
    return
  }
  if (command === "show") {
    if (parsed.args.length !== 1) throw new Error("show requires exactly one selector")
    const value = parsed.args[0]
    if (!value.includes("/") && config.architectures.has(value)) { await showArchitecture(config, config.architectures.get(value)!, active, colorsEnabled()); return }
    const selected = selector(value, active.architecture); const architecture = await architectureFor(config, selected.architecture); await showFleet(config, architecture, await loadFleet(config, selected.architecture, selected.fleet), active, colorsEnabled()); return
  }
  if (command === "use") {
    if (parsed.args.length !== 1) throw new Error("use requires exactly one fleet or architecture/fleet")
    const selected = selector(parsed.args[0], active.architecture); await architectureFor(config, selected.architecture); const next = await writeState(config, selected.architecture, selected.fleet, parsed.state)
    if (parsed.noRestart) { console.log(`Active model fleet: ${next.architecture}/${next.fleet}; service restart skipped.`); return }
    try { restart() } catch (error) { throw new Error(`Selection ${next.architecture}/${next.fleet} was saved, but the running service may be stale: ${error instanceof Error ? error.message : String(error)}`) }
    console.log(`Active model fleet: ${next.architecture}/${next.fleet}`); return
  }
  throw new Error(`Unknown command "${command}"\n${HELP}`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) run().catch((error) => { console.error(`agents-fleet: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 })
