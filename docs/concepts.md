# Concepts

An architecture describes *which agents exist and how they are governed*.
Its exhaustive roster explicitly enables or disables every managed agent.
Enabled agents point at route slots; disabled entries contain no behavior
configuration. Architecture files also bind relative prompt and context-memory
files to agents.

A fleet describes *which models serve those slots*. It has no agent IDs,
prompts, permissions, or memory. A chain starts with a primary and may contain
fallbacks. `openrouter` may appear only at the end of a chain.

The selected architecture and fleet are persisted as versioned state. The
plugin loads one immutable snapshot during setup. Changing a fleet preserves
the architecture activation boundary; changing architecture starts a new
boundary, so old sessions cannot receive the new architecture's memory.
