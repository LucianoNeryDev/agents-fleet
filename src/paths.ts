import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

export function configRoot(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const candidate = explicit ?? env.AGENTS_FLEET_HOME
  if (candidate !== undefined) {
    if (!isAbsolute(candidate)) throw new Error("AGENTS_FLEET_HOME/config directory must be an absolute path")
    return resolve(candidate)
  }
  const xdg = env.XDG_CONFIG_HOME
  if (xdg) {
    if (!isAbsolute(xdg)) throw new Error("XDG_CONFIG_HOME must be an absolute path")
    return join(xdg, "agents-fleet")
  }
  return join(env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir(), ".config", "agents-fleet")
}

export function stateFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_STATE_HOME
  const base = xdg ? (isAbsolute(xdg) ? xdg : join(env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir(), ".local", "state")) : join(env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir(), ".local", "state")
  return join(base, "agents-fleet", "state.json")
}
