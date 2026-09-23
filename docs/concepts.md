# Concepts

A **fleet** describes *which agents exist and how they are governed*. Its
exhaustive roster explicitly enables or disables every managed agent. Enabled
agents name a line; disabled entries contain no behavior configuration. Fleet
files also bind relative prompt and context-memory files to agents.

A **line** describes *which models serve an agent*. It is a named chain — one
primary followed by optional fallbacks — stored in the shared `lines/` catalog
at the configuration root. No fleet owns a line: any fleet may reference any
line, and one line can serve several agents across several fleets. Agents write
the reference, never the chain:

```json
{ "line": "$frontier" }
```

```text
lines/frontier.json:
  openai/gpt-5-codex -> anthropic/claude-sonnet-4 -> openrouter/openai/gpt-5-codex
```

A chain starts with a primary and may contain fallbacks. `openrouter` may appear
only at the end of a chain. A line referenced by an agent must exist in the
catalog; unused lines are allowed, because the catalog is shared.

The selected fleet is persisted as versioned state. The plugin loads one
immutable snapshot during setup. Changing a fleet starts a new activation
boundary, so old sessions cannot receive the new fleet's memory. Lines carry no
memory and are deliberately outside that boundary: repointing a line changes
which models a restarted service uses without invalidating existing sessions.
