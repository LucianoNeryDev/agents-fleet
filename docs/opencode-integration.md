# OpenCode V2 integration

The package exports a default plugin definition from `agents-fleet/plugin`.
It uses the OpenCode V2 promise SDK (`@opencode-ai/plugin/v2/promise`) and the
V2 `agent.transform` domain; it does not use the legacy V1 plugin API.

After building from source, add the built plugin to an OpenCode V2
configuration (replace both placeholders with absolute paths):

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/agents-fleet/dist/plugin.js",
      "options": {
        "configRoot": "/absolute/path/to/your/agents-fleet-config"
      }
    }
  ]
}
```

This pre-release is intended to be installed from source: run `npm install`
and `npm run build` in a checkout, then make the built package available to
OpenCode. It is not yet a published npm release. Without a `configRoot`
option, the plugin uses `AGENTS_FLEET_HOME`, then
`$XDG_CONFIG_HOME/agents-fleet`, then `~/.config/agents-fleet`. Selection state
is read from `$XDG_STATE_HOME/agents-fleet/state.json`, falling back to
`~/.local/state/agents-fleet/state.json`; `statePath` may override it for an
isolated setup.

After a future npm release, the source path can be replaced with the package
subpath `agents-fleet/plugin`.

At setup the plugin resolves its config root (the `configRoot` option first),
validates the shared line catalog and every fleet, reads prompt files, and
captures one activation snapshot. Enabled configured agents must already be
present in OpenCode's static agent catalog; the plugin cannot dynamically add
agents. Managed disabled agents are removed; unmanaged agents are not touched.
Each selected agent's model is replaced with the primary model of the line it
binds, and safe optional fields are updated. Permissions remain untouched, so
the static catalog remains the capability ceiling.

Prompt replacement and append behavior is applied from the snapshot. The
runtime exports `handleRetry`, `injectContext`, and `registerRuntimeHooks` for
V2 hosts that expose the corresponding runtime domains. Retryable provider
failures advance through the same snapshot chain; if the current model is not
in the agent's line, the primary is selected, and an event that names no agent
falls back to the fleet's `defaultLine`. Context injection requires the event's
exact agent owner and enforces the fleet activation session boundary.

Changing the fleet persists a new activation boundary. Existing sessions created
before that boundary cannot receive the new fleet's memory and should be
replaced. Editing or adding a line does not create a boundary; the new chain is
used after the next service start, and existing sessions keep working. A normal
selection restarts OpenCode with `opencode service restart`, while
`--no-restart` is useful for inspection. A failed restart leaves the persisted
selection in place and the running service may still be stale.

Project memory is independent and intentionally out of scope. Provider
credentials are also independent and never handled here.
