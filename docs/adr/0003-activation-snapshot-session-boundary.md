# ADR 0003: Activate one snapshot with a session boundary

## Decision

The plugin loads and validates configuration once during setup. Fleet switches
create a timestamp boundary; line changes never do. Context memory is injected
only into sessions created at or after that boundary.

## Rationale

A running service must not observe half of a configuration switch. Blocking old
sessions prevents fleet memory from being mixed across boundaries. Lines carry
no memory, so a model change is safe to apply without a boundary; it simply
takes effect on the next service start.
