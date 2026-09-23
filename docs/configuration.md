# Configuration

The root is selected in this order: an explicit plugin or CLI option,
`AGENTS_FLEET_HOME` (which must be absolute), `$XDG_CONFIG_HOME/agents-fleet`,
then `~/.config/agents-fleet`. Its layout is:

```text
lines/<line>.json
fleets/<fleet>/fleet.json
fleets/<fleet>/prompts/*.md
fleets/<fleet>/memory/*.md
```

Lines are global and shared by every fleet; fleets own topology, prompts, and
memory. Schemas are in [`schemas/`](../schemas/). Fleet and line examples use
valid relative `$schema` references. IDs, selectors, and source IDs use lowercase
kebab case; a line reference is `$` followed by the same kebab-case ID.

A **line v1** has `id`, `name`, `description`, and a non-empty `chain`. The chain
starts with the primary model and may list fallbacks. Chains cannot repeat a
provider/model pair, variants do not make duplicates distinct, and `openrouter`
may appear only as the last hop.

A **fleet v1** has `id`, `name`, `description`, `defaultAgent`, an agent map, and
a context-source catalog. Every enabled agent names a line:

```json
{ "enabled": true, "line": "$frontier", "mode": "primary" }
```

The referenced line must exist in the shared catalog. `defaultLine` is optional
and is used when a runtime event names no agent. Agent prompt policies are
`preserve-static`, `replace`, or `append` with relative file paths. Context
sources declare their exact owner, relative path, required flag, heading, and
positive `maxBytes` limit. Fleets must not inline lines; model definitions belong
in the catalog so one chain is written once.

No credentials are read or stored. Configure providers in OpenCode itself.

## Authoring loop

Start from `agents-fleet init`, keep `$schema` references intact for editor
feedback, and run both commands after changes:

```sh
agents-fleet validate
agents-fleet doctor --offline
```

`validate` is the strict runtime gate and stops at the first load failure.
`doctor` reports independent fleet, line, context-source, state, and schema
issues in one read-only pass, even when the strict loader would stop early. Run
doctor without `--offline` to compare provider/model IDs and selected static
agents with a running OpenCode V2 service. See [Diagnostics](diagnostics.md).

The bundled example includes a minimal `free` fleet and the shared `$free` line.
Every enabled agent binds that line, which resolves to the exact model
`opencode/muse-spark-1.3-contributor-free` (Muse Spark 1.3 Free). This is an
illustrative active model discovered from the current OpenCode catalog;
authentication and availability remain OpenCode's responsibility. The
`software-team` fleet instead binds three different shared lines — `$frontier`,
`$standard`, and `$economy` — to show one catalog serving several agents.
