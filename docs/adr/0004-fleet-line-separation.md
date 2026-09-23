# ADR 0004: Rename architectures to fleets and extract shared lines

**Supersedes [ADR 0001](0001-architecture-fleet-separation.md).**

## Decision

The document that owns agent topology, prompts, and context-memory bindings is
called a **fleet** (`fleets/<id>/fleet.json`). Model chains move out of
per-fleet route slots into one shared catalog of **lines** (`lines/<id>.json`).
An enabled agent names a line with `"line": "$name"`; no fleet owns a line.

## Rationale

Route slots made every agent restate the chain it used and tied model economics
to a single fleet. A named, global line is written once and referenced by any
agent in any fleet, so a fleet describes capability and memory while a line
describes models. Keeping the catalog global means a new fleet does not
duplicate model definitions, and the vocabulary matches the domain: one fleet,
many lines.

## Consequences

- The activation boundary tracks only the selected fleet. Lines carry no
  memory, so repointing a line cannot invalidate existing sessions.
- Unused lines are legal; the catalog is shared, not owned.
- Route slots disappear. Retry still needs a chain for events that name no
  agent, so a fleet may declare an optional `defaultLine`.
- State changes shape to `{ fleet, fleetActivatedAt }`, and a selection is a
  single fleet ID.
- `architecture-v1.schema.json` and `fleet-v1.schema.json` swap roles: the fleet
  schema now describes the agent roster, and the new line schema describes the
  chain.
