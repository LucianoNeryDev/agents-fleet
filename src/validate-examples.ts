import { join } from "node:path"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { loadConfig } from "./loader.js"
import { validateFleet, validateLine } from "./validation.js"

const root = join(fileURLToPath(new URL("..", import.meta.url)), "examples", "software-team")
const config = await loadConfig(root)
const lineIDs = new Set(config.lines.keys())
for (const line of config.lines.values()) validateLine(line)
for (const fleet of config.fleets.values()) {
  const raw = JSON.parse(await readFile(join(fleet.directory, "fleet.json"), "utf8"))
  validateFleet(raw, config.managedAgentIDs, lineIDs)
}
console.log(`Validated ${config.fleets.size} example fleet(s) and ${config.lines.size} line(s)`)
