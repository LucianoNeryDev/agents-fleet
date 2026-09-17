# ADR 0003: Activate one snapshot with a session boundary

## Decision

The plugin loads and validates configuration once during setup. Architecture
switches create a timestamp boundary; fleet-only switches preserve it.
Context memory is injected only into sessions created at or after that
boundary.

## Rationale

A running service must not observe half of a configuration switch. Blocking old
sessions prevents architecture memory from being mixed across boundaries.
