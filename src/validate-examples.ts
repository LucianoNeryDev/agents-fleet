import { join } from "node:path"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { loadAllFleets, loadConfig } from "./loader.js"
import { validateArchitecture, validateFleet } from "./validation.js"

const root = join(fileURLToPath(new URL("..", import.meta.url)), "examples", "software-team")
const config = await loadConfig(root)
for (const architecture of config.architectures.values()) {
  const raw = JSON.parse(await readFile(join(architecture.directory, "architecture.json"), "utf8"))
  validateArchitecture(raw, config.managedAgentIDs)
  const fleets = await loadAllFleets(config, architecture.id)
  for (const fleet of fleets.values()) validateFleet(fleet, new Set(Object.values(architecture.agents).filter((agent) => agent.enabled).map((agent) => agent.routeSlot!)))
}
console.log(`Validated ${config.architectures.size} example architecture(s)`)
