# ADR 0001: Separate architectures from fleets

## Decision

Architecture files own agent topology, policies, prompts, and context
bindings. Fleet files own route-slot model chains only.

## Rationale

Users can change model economics without changing capabilities or memory. The
separation also makes validation and review straightforward.
