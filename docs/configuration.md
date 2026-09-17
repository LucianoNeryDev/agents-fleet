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
