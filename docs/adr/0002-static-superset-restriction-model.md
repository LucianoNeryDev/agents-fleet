# ADR 0002: Use a static superset and restriction model

## Decision

Fleets may enable or disable agents from OpenCode's pre-existing static
catalog, but the plugin never dynamically registers agents. Every fleet
explicitly declares the catalog-wide managed union.

## Rationale

OpenCode V2's agent editor can update and remove entries but cannot safely add
arbitrary agents. Treating the static catalog as a capability ceiling avoids
accidental permission expansion and makes disabled-agent behavior deterministic.
