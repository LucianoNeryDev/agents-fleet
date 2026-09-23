import { spawnSync } from "node:child_process"
import { constants } from "node:fs"
import { access, readFile, readdir, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { configRoot as defaultConfigRoot, stateFilePath } from "./paths.js"
import { loadConfig } from "./loader.js"
import { loadState, selectState } from "./state.js"
import { assertContainedPath, assertID, validateFleet, validateLine } from "./validation.js"
import type { Fleet, Line, LoadedConfig } from "./types.js"

export type DiagnosticSeverity = "error" | "warning" | "info" | "skipped"
export type Diagnostic = Readonly<{
  code: string
  severity: DiagnosticSeverity
  message: string
  location?: string
  hint?: string
}>
export type DoctorSelection = Readonly<{ fleet: string }>
export type DiagnosticSummary = Readonly<Record<DiagnosticSeverity, number>>
export type DoctorReport = Readonly<{
  version: 1
  ok: boolean
  complete: boolean
  selection?: DoctorSelection
  opencodeVersion?: string
  summary: DiagnosticSummary
  diagnostics: readonly Diagnostic[]
}>
export type DiagnosticReport = DoctorReport

export type DoctorOptions = Readonly<{
  configRoot?: string
  statePath?: string
  offline?: boolean
  env?: NodeJS.ProcessEnv
}>

const LIVE_TIMEOUT_MS = 10_000
const LIVE_MAX_BUFFER = 1024 * 1024

export function doctorExitCode(report: DoctorReport): 0 | 1 | 2 {
  if (!report.complete) return 2
  return report.ok ? 0 : 1
}

/** Applies the same single-executable policy to restart and read-only probes. */
export function validateOpenCodeExecutable(executable = process.env.OPENCODE_BIN || "opencode"): string {
  if (!executable || /[\0\s]/.test(executable) || executable.startsWith("-")) {
    throw new Error("OPENCODE_BIN must be one executable path/name, not a shell command")
  }
  return executable
}

function diagnostic(code: string, severity: DiagnosticSeverity, message: string, location?: string, hint?: string): Diagnostic {
  return { code, severity, message, ...(location ? { location } : {}), ...(hint ? { hint } : {}) }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeError(error: unknown, root: string): string {
  return errorMessage(error).split(resolve(root)).join("<config>")
}

function configFailure(error: unknown, root: string): Diagnostic {
  return diagnostic(
    "CONFIG_INVALID",
    "error",
    `Configuration could not be loaded or validated: ${safeError(error, root)}`,
    "config",
    "Fix the fleet and line JSON, prompts, and containment paths, then run doctor again."
  )
}

function logicalFile(root: string, path: string): string {
  const value = relative(root, path).split("\\").join("/")
  return value && !value.startsWith("..") && !isAbsolute(value) ? value : "config"
}

function schemaLocation(root: string, path: string): string {
  return logicalFile(root, path)
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown
}

async function jsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name.slice(0, -5)).sort()
}

type LineInventory = ReadonlyMap<string, Line>

/** Independently validates every line file so one broken file does not hide the others. */
async function inspectLines(root: string, diagnostics: Diagnostic[]): Promise<LineInventory> {
  const directory = join(root, "lines")
  let files: string[]
  try { files = await jsonFiles(directory) }
  catch {
    diagnostics.push(diagnostic("LINES_UNREADABLE", "error", "The shared line catalog directory is not readable.", "lines", "Restore the lines directory and ensure it is readable."))
    return new Map()
  }
  const lines = new Map<string, Line>()
  if (!files.length) {
    diagnostics.push(diagnostic("LINES_MISSING", "error", "The shared line catalog contains no line files.", "lines", "Add at least one valid line JSON file."))
    return lines
  }
  for (const id of files) {
    const location = `lines/${id}.json`
    try {
      assertID(id, `Line file ${id}`)
      const value = await readJson(join(directory, `${id}.json`)) as Line
      if (value.id !== id) throw new Error("Line file has mismatched ID")
      validateLine(value)
      lines.set(id, value)
    } catch (error) {
      diagnostics.push(diagnostic("LINE_INVALID", "error", `Line "${id}" could not be read or validated: ${safeError(error, root)}`, location, "Fix this line file and run doctor again."))
    }
  }
  return lines
}

/** Independently validates every fleet file against the line catalog and the managed union. */
async function inspectFleets(root: string, lineIDs: ReadonlySet<string>, diagnostics: Diagnostic[]): Promise<void> {
  const directory = join(root, "fleets")
  let directories: string[]
  try { directories = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name !== "node_modules").map((entry) => entry.name).sort() }
  catch {
    diagnostics.push(diagnostic("FLEETS_UNREADABLE", "error", "The fleets directory is not readable.", "fleets", "Restore the directory and ensure it is readable."))
    return
  }
  const raw = new Map<string, Fleet>()
  if (!directories.length) {
    diagnostics.push(diagnostic("FLEETS_MISSING", "error", "The configuration contains no fleet directories.", "fleets", "Add at least one fleet directory with a fleet.json file."))
    return
  }
  for (const id of directories) {
    const location = `fleets/${id}/fleet.json`
    try {
      assertID(id, `Fleet directory ${id}`)
      const value = await readJson(join(directory, id, "fleet.json")) as Fleet
      if (value.id !== id) throw new Error("Fleet file has mismatched ID")
      validateFleet(value, undefined, lineIDs)
      raw.set(id, value)
    } catch (error) {
      diagnostics.push(diagnostic("FLEET_INVALID", "error", `Fleet "${id}" could not be read or validated: ${safeError(error, root)}`, location, "Fix this fleet file and run doctor again."))
    }
  }
  const managed = new Set<string>()
  for (const value of raw.values()) for (const id of Object.keys(value.agents)) managed.add(id)
  for (const [id, value] of raw) {
    const location = `fleets/${id}/fleet.json`
    try { validateFleet(value, managed, lineIDs) }
    catch (error) { diagnostics.push(diagnostic("FLEET_INVALID", "error", `Fleet "${id}" could not be read or validated: ${safeError(error, root)}`, location, "Fix this fleet file and run doctor again.")) }
  }
}

async function inspectContexts(config: LoadedConfig, diagnostics: Diagnostic[]): Promise<void> {
  for (const fleet of [...config.fleets.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const [sourceID, source] of Object.entries(fleet.contextSources).sort(([left], [right]) => left.localeCompare(right))) {
      const location = `fleets/${fleet.id}/fleet.json:contextSources.${sourceID}`
      let path: string
      try {
        path = await assertContainedPath(fleet.directory, source.relativePath, `Context source ${sourceID}`)
      } catch {
        diagnostics.push(diagnostic("CONTEXT_CONTAINMENT", "error", `Context source "${sourceID}" failed containment validation.`, location, "Keep the source path relative and inside its fleet directory."))
        continue
      }
      try {
        await access(path, constants.R_OK)
        const metadata = await stat(path)
        if (!metadata.isFile()) throw new Error("Context source is not a regular file")
        if (metadata.size > source.maxBytes) diagnostics.push(diagnostic("CONTEXT_OVERSIZE", "error", `Context source "${sourceID}" is ${metadata.size} bytes and exceeds its ${source.maxBytes}-byte limit.`, location, "Reduce the file or increase maxBytes deliberately."))
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT" && !source.required) {
          diagnostics.push(diagnostic("CONTEXT_OPTIONAL_MISSING", "info", `Optional context source "${sourceID}" is missing.`, location))
        } else {
          diagnostics.push(diagnostic(source.required ? "CONTEXT_REQUIRED_MISSING" : "CONTEXT_UNREADABLE", "error", `${source.required ? "Required " : ""}context source "${sourceID}" could not be read.`, location, "Restore the file or update the context source definition."))
        }
        continue
      }
    }
  }
  diagnostics.push(diagnostic("CONTEXT_CHECKED", "info", "Context sources passed containment and size checks where readable.", "context"))
}

async function schemaRef(value: unknown, root: string, file: string, diagnostics: Diagnostic[]): Promise<void> {
  const location = schemaLocation(root, file)
  if (typeof value !== "string" || !value) {
    diagnostics.push(diagnostic("SCHEMA_MISSING", "warning", "No usable local schema reference was declared.", location, "Add a relative $schema reference to the bundled v1 schema."))
    return
  }
  if (/^https?:\/\//i.test(value)) {
    diagnostics.push(diagnostic("SCHEMA_REMOTE_NOT_FETCHED", "info", "Remote schema reference accepted; doctor does not fetch schemas.", location))
    return
  }
  if (isAbsolute(value) || /^[a-z][a-z\d+.-]*:/i.test(value)) {
    diagnostics.push(diagnostic("SCHEMA_REF_UNSUPPORTED", "warning", "Schema reference is not a relative local reference.", location, "Use a relative path to a local v1 schema."))
    return
  }
  const target = resolve(dirname(file), value.split(/[?#]/, 1)[0])
  try { await access(target, constants.R_OK) } catch {
    diagnostics.push(diagnostic("SCHEMA_REF_UNRESOLVED", "warning", "Relative schema reference does not resolve to a readable file.", location, "Fix the relative $schema path."))
  }
}

async function inspectSchemas(config: LoadedConfig, lines: LineInventory, diagnostics: Diagnostic[]): Promise<void> {
  const checks: Array<{ value: unknown; file: string }> = []
  for (const fleet of [...config.fleets.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    const file = join(fleet.directory, "fleet.json")
    try { checks.push({ value: (await readJson(file) as Record<string, unknown>).$schema, file }) } catch { /* config loading already diagnosed this case */ }
  }
  for (const id of [...lines.keys()].sort()) {
    const file = join(config.root, "lines", `${id}.json`)
    try { checks.push({ value: (await readJson(file) as Record<string, unknown>).$schema, file }) } catch { /* line validation already diagnosed this case */ }
  }
  for (const check of checks) await schemaRef(check.value, config.root, check.file, diagnostics)
  diagnostics.push(diagnostic("SCHEMA_CHECKED", "info", "Fleet and line schema references were inspected without fetching remote schemas.", "schemas"))
}

function selectionFrom(config: LoadedConfig, statePath: string, diagnostics: Diagnostic[]): Promise<DoctorSelection | undefined> {
  return (async () => {
    let state
    try { state = await loadState(statePath) } catch {
      diagnostics.push(diagnostic("STATE_INVALID", "error", "Activation state is invalid or unreadable.", "state", "Remove or repair the state file, or run agents-fleet use <fleet> to replace it."))
      return undefined
    }
    let selected
    try { selected = await selectState(config, statePath) } catch {
      diagnostics.push(diagnostic("STATE_SELECTION_INVALID", "error", "No valid runtime fleet selection can be made from the activation state and configured fleets.", "state", "Fix invalid fleets, then select a fleet that exists in this configuration."))
      return undefined
    }
    if (!state) diagnostics.push(diagnostic("STATE_MISSING", "info", `Activation state is missing; deterministic selection is "${selected.fleet}".`, "state", "Use agents-fleet use to persist this selection."))
    else diagnostics.push(diagnostic("STATE_VALID", "info", "Activation state is valid and selects a configured fleet.", "state"))
    return { fleet: selected.fleet }
  })()
}

/** Line IDs bound by the selected fleet; only those gaps are blocking. */
function selectedLineIDs(config: LoadedConfig, selection: DoctorSelection | undefined): ReadonlySet<string> {
  const ids = new Set<string>()
  if (!selection) return ids
  const fleet = config.fleets.get(selection.fleet)
  if (!fleet) return ids
  for (const [, line] of fleet.linesByAgent) ids.add(line.id)
  if (fleet.defaultLine) ids.add(fleet.defaultLine.id)
  return ids
}

type ModelCatalog = Readonly<{
  agents: ReadonlySet<string>
  providers: ReadonlySet<string>
  models: ReadonlyMap<string, ReadonlySet<string>>
}>

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function normalizeIDs(data: unknown[], kind: "agent" | "provider"): Set<string> {
  const ids = new Set<string>()
  for (const value of data) {
    const item = object(value)
    if (!item || typeof item.id !== "string" || !item.id) throw new Error(`${kind}.list returned an invalid record`)
    ids.add(item.id)
  }
  return ids
}

function variantIDs(value: unknown): Set<string> {
  const variants = new Set<string>()
  if (value === undefined) return variants
  if (!Array.isArray(value)) throw new Error("model.list returned invalid variants")
  for (const entry of value) {
    const item = object(entry)
    if (!item || typeof item.id !== "string" || !item.id) throw new Error("model.list returned an invalid variant record")
    variants.add(item.id)
  }
  return variants
}

function normalizeModels(data: unknown[]): Map<string, Set<string>> {
  const models = new Map<string, Set<string>>()
  for (const value of data) {
    const item = object(value)
    if (!item || typeof item.providerID !== "string" || !item.providerID || typeof item.modelID !== "string" || !item.modelID) throw new Error("model.list returned an invalid record")
    models.set(`${item.providerID}\u0000${item.modelID}`, variantIDs(item.variants))
  }
  return models
}

type ProbeResult = Readonly<{ ok: true; data: unknown[] } | { ok: false }>

function probe(executable: string, args: string[], env: NodeJS.ProcessEnv): ProbeResult {
  try {
    const result = spawnSync(executable, args, { encoding: "utf8", shell: false, timeout: LIVE_TIMEOUT_MS, maxBuffer: LIVE_MAX_BUFFER, env })
    if (result.error || result.signal || result.status !== 0) return { ok: false }
    let envelope: unknown
    try { envelope = JSON.parse(typeof result.stdout === "string" ? result.stdout : String(result.stdout)) } catch { return { ok: false } }
    const item = object(envelope)
    if (!item || !Object.hasOwn(item, "location") || !Array.isArray(item.data)) return { ok: false }
    return { ok: true, data: item.data }
  } catch {
    return { ok: false }
  }
}

function extractVersion(value: string): { value?: string; v2: boolean } {
  const version = value.match(/\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1]
  return { value: version, v2: Boolean(version?.startsWith("2.")) }
}

type OpenCodeInspection = { version?: string; complete: boolean }

async function inspectOpenCode(config: LoadedConfig, selection: DoctorSelection | undefined, diagnostics: Diagnostic[], env: NodeJS.ProcessEnv): Promise<OpenCodeInspection> {
  let executable: string
  try { executable = validateOpenCodeExecutable(env.OPENCODE_BIN || "opencode") } catch {
    diagnostics.push(diagnostic("OPENCODE_EXECUTABLE_INVALID", "error", "OpenCode executable configuration is invalid.", "opencode", "Set OPENCODE_BIN to one executable path or name."))
    return { complete: false }
  }
  const versionResult = (() => {
    try {
      const result = spawnSync(executable, ["--version"], { encoding: "utf8", shell: false, timeout: LIVE_TIMEOUT_MS, maxBuffer: LIVE_MAX_BUFFER, env })
      if (result.error || result.signal || result.status !== 0) return { failed: true as const }
      return extractVersion(typeof result.stdout === "string" ? result.stdout : String(result.stdout))
    } catch { return { failed: true as const } }
  })()
  if ("failed" in versionResult) {
    diagnostics.push(diagnostic("OPENCODE_VERSION_INCOMPLETE", "error", "OpenCode version probe could not complete.", "opencode --version", "Check OPENCODE_BIN and run doctor again."))
    return { complete: false }
  }
  if (!versionResult.value) {
    diagnostics.push(diagnostic("OPENCODE_VERSION_MALFORMED", "error", "OpenCode version probe returned no recognizable version.", "opencode --version", "Use a supported OpenCode V2 executable."))
    return { complete: false }
  }
  if (!versionResult.v2) {
    diagnostics.push(diagnostic("OPENCODE_NOT_V2", "error", "The selected OpenCode executable is not an OpenCode V2 executable.", "opencode --version", "Use an OpenCode V2 executable."))
    return { version: versionResult.value, complete: true }
  }
  const agentResult = probe(executable, ["api", "agent.list"], env)
  const modelResult = probe(executable, ["api", "model.list"], env)
  const providerResult = probe(executable, ["api", "provider.list"], env)
  if (!agentResult.ok || !modelResult.ok || !providerResult.ok) {
    diagnostics.push(diagnostic("OPENCODE_PROBES_INCOMPLETE", "error", "One or more OpenCode V2 catalog probes did not complete.", "opencode api", "Check the executable and its API output; no probe output is retained."))
    return { version: versionResult.value, complete: false }
  }
  let catalog: ModelCatalog
  try { catalog = { agents: normalizeIDs(agentResult.data, "agent"), providers: normalizeIDs(providerResult.data, "provider"), models: normalizeModels(modelResult.data) } }
  catch {
    diagnostics.push(diagnostic("OPENCODE_RESPONSE_MALFORMED", "error", "An OpenCode V2 catalog contained an invalid record.", "opencode api", "Verify that OPENCODE_BIN points to a compatible OpenCode V2 executable; raw records were discarded."))
    return { version: versionResult.value, complete: false }
  }
  if (selection) {
    const fleet = config.fleets.get(selection.fleet)
    if (fleet) {
      for (const agentID of Object.entries(fleet.agents).filter(([, agent]) => agent.enabled).map(([id]) => id).sort()) {
        if (!catalog.agents.has(agentID)) diagnostics.push(diagnostic("AGENT_MISSING", "error", `Selected fleet agent "${agentID}" is not present in the active OpenCode catalog.`, `fleets/${selection.fleet}/fleet.json:agents.${agentID}`, "Enable or install the agent in OpenCode, or choose another fleet."))
      }
      diagnostics.push(diagnostic("CATALOG_TRANSFORMED", "info", "The active agent catalog is transformed by the selected fleet; inactive static-superset prerequisites cannot be proven.", "opencode api agent.list"))
    }
  }
  type Missing = { severity: "error" | "warning"; locations: string[] }
  const missingProviders = new Map<string, Missing>()
  const missingModels = new Map<string, Missing>()
  const missingVariants = new Map<string, Missing>()
  const addMissing = (map: Map<string, Missing>, key: string, selected: boolean, location: string): void => {
    const existing = map.get(key)
    if (!existing) map.set(key, { severity: selected ? "error" : "warning", locations: [location] })
    else {
      if (selected) existing.severity = "error"
      if (!existing.locations.includes(location)) existing.locations.push(location)
    }
  }
  const used = selectedLineIDs(config, selection)
  for (const line of [...config.lines.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    const selectedLine = used.has(line.id)
    for (const [index, ref] of line.chain.entries()) {
      const location = `lines/${line.id}.json:chain[${index}]`
      if (!catalog.providers.has(ref.providerID)) { addMissing(missingProviders, ref.providerID, selectedLine, location); continue }
      const modelKey = `${ref.providerID}\u0000${ref.modelID}`
      if (!catalog.models.has(modelKey)) { addMissing(missingModels, modelKey, selectedLine, location); continue }
      if (ref.variant && !catalog.models.get(modelKey)!.has(ref.variant)) addMissing(missingVariants, `${modelKey}\u0000${ref.variant}`, selectedLine, location)
    }
  }
  for (const [provider, item] of [...missingProviders].sort(([left], [right]) => left.localeCompare(right))) diagnostics.push(diagnostic("PROVIDER_MISSING", item.severity, `${item.severity === "error" ? "Selected" : "Inactive"} line provider "${provider}" is not present in the OpenCode catalog.`, item.locations.join(", "), "Configure the provider in OpenCode or bind a line using an available provider."))
  for (const [key, item] of [...missingModels].sort(([left], [right]) => left.localeCompare(right))) { const [provider, model] = key.split("\u0000"); diagnostics.push(diagnostic("MODEL_MISSING", item.severity, `${item.severity === "error" ? "Selected" : "Inactive"} line model "${provider}/${model}" is not present in the OpenCode catalog.`, item.locations.join(", "), "Choose an available model or configure the provider in OpenCode.")) }
  for (const [key, item] of [...missingVariants].sort(([left], [right]) => left.localeCompare(right))) { const [provider, model, variant] = key.split("\u0000"); diagnostics.push(diagnostic("VARIANT_MISSING", item.severity, `${item.severity === "error" ? "Selected" : "Inactive"} line variant "${provider}/${model}#${variant}" is not present in the OpenCode catalog.`, item.locations.join(", "), "Choose an available variant or remove the variant from the line.")) }
  diagnostics.push(diagnostic("OPENCODE_CATALOG_CHECKED", "info", "OpenCode catalogs were checked; catalog presence does not prove credentials, quota, or request success.", "opencode api"))
  return { version: versionResult.value, complete: true }
}

function summaryOf(diagnostics: readonly Diagnostic[]): DiagnosticSummary {
  const summary = { error: 0, warning: 0, info: 0, skipped: 0 }
  for (const item of diagnostics) summary[item.severity] += 1
  return summary
}

export async function runDiagnostics(options: DoctorOptions = {}): Promise<DoctorReport> {
  const root = resolve(options.configRoot ?? defaultConfigRoot(undefined, options.env))
  const diagnostics: Diagnostic[] = []
  const lines = await inspectLines(root, diagnostics)
  diagnostics.push(diagnostic("LINES_CHECKED", "info", "Every line file in the shared catalog was inspected independently.", "lines"))
  await inspectFleets(root, new Set(lines.keys()), diagnostics)
  diagnostics.push(diagnostic("FLEETS_CHECKED", "info", "All fleet files were inspected independently against the shared line catalog.", "fleets"))
  let config: LoadedConfig
  try { config = await loadConfig(root) } catch (error) {
    diagnostics.push(configFailure(error, root))
    if (options.offline) diagnostics.push(diagnostic("LIVE_CHECKS_SKIPPED", "skipped", "Live OpenCode checks skipped (--offline).", "opencode"))
    const report = { version: 1 as const, ok: false, complete: true, summary: summaryOf(diagnostics), diagnostics }
    return report
  }
  diagnostics.push(diagnostic("CONFIG_VALID", "info", "Configuration passed fleet, line, and containment validation.", "config"))
  const selection = await selectionFrom(config, options.statePath ?? stateFilePath(options.env), diagnostics)
  await inspectContexts(config, diagnostics)
  await inspectSchemas(config, lines, diagnostics)
  let opencodeVersion: string | undefined
  let complete = true
  if (options.offline) diagnostics.push(diagnostic("LIVE_CHECKS_SKIPPED", "skipped", "Live OpenCode checks skipped (--offline).", "opencode"))
  else {
    const inspection = await inspectOpenCode(config, selection, diagnostics, options.env ?? process.env)
    opencodeVersion = inspection.version
    complete = inspection.complete
  }
  const report = { version: 1 as const, ok: !diagnostics.some((item) => item.severity === "error"), complete, ...(selection ? { selection } : {}), ...(opencodeVersion ? { opencodeVersion } : {}), summary: summaryOf(diagnostics), diagnostics }
  return report
}

export const diagnose = runDiagnostics
