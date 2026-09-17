# Architecture and security model

The architecture/fleet split prevents a model choice from silently changing
agent topology, prompts, permissions, or memory. The static-superset rule
means every architecture declares every managed agent; this prevents a
disabled agent from leaking through a transform while preserving unrelated
future OpenCode agents.

Validation rejects unsafe IDs and selectors, empty chains, duplicate
provider/model pairs, non-terminal OpenRouter hops, missing route slots,
unknown context sources, and ownership mismatches. Prompt and context paths
are resolved beneath the real architecture directory. Traversal and symlink
escapes are rejected, and context byte limits are checked before injection.

State lives at `$XDG_STATE_HOME/agents-fleet/state.json`, or
`~/.local/state/agents-fleet/state.json`. The directory is mode 0700 and the
state file is written mode 0600 through a temporary file, rename, file fsync,
and best-effort directory fsync. State is never imported from another local
tool automatically.

The plugin snapshot is an activation boundary: disk edits affect a newly
started service, not a partially running one. Architecture memory is blocked
for sessions created before the boundary. A fleet-only selection preserves the
boundary.
