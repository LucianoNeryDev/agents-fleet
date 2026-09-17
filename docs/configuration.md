# Configuration

The root is selected in this order: an explicit plugin or CLI option,
`AGENTS_FLEET_HOME` (which must be absolute), `$XDG_CONFIG_HOME/agents-fleet`,
then `~/.config/agents-fleet`. Its layout is:

```text
architectures/<architecture>/architecture.json
architectures/<architecture>/fleets/<fleet>.json
architectures/<architecture>/prompts/*.md
architectures/<architecture>/memory/*.md
```

Schemas are in [`schemas/`](../schemas/). Architecture and fleet examples use
valid relative `$schema` references. IDs, selectors, route slots, and source
IDs use lowercase kebab case.

An architecture v1 has `id`, `name`, `description`, `defaultAgent`, an agent
map, and a context-source catalog. Agent prompt policies are
`preserve-static`, `replace`, or `append` with relative file paths. Context
sources declare their exact owner, relative path, required flag, heading, and
positive `maxBytes` limit.

A fleet v1 has `id`, `name`, `description`, `chains`, and optionally
`defaultChain`. Every enabled route slot must occur exactly once in every
fleet. Chains cannot be empty or repeat a provider/model pair; variants do not
make duplicates distinct.

No credentials are read or stored. Configure providers in OpenCode itself.

## Authoring loop

Start from `agents-fleet init`, keep `$schema` references intact for editor
feedback, and run both commands after changes:

```sh
agents-fleet validate
agents-fleet doctor --offline
```

`validate` is the strict runtime gate and stops at the first load failure.
`doctor` reports independent fleet, context-source, state, and schema issues in
one read-only pass where configuration loading permits it. Run doctor without
`--offline` to compare provider/model IDs and selected static agents with a
running OpenCode V2 service. See [Diagnostics](diagnostics.md).

The bundled example includes a minimal `free` architecture and `free` fleet.
Every enabled agent uses the shared `all` route and the exact model
`opencode/muse-spark-1.3-contributor-free` (Muse Spark 1.3 Free). This is an
illustrative active model discovered from the current OpenCode catalog;
authentication and availability remain OpenCode's responsibility.
