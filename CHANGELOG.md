# Changelog

## Unreleased

- Replace the architecture/fleet split with fleets and shared lines. A fleet
  (`fleets/<id>/fleet.json`) owns agent topology, prompts, and context-memory
  bindings; a line (`lines/<id>.json`) is a named primary-plus-fallbacks chain
  in one shared catalog that any fleet references as `$name`. Route slots and
  per-fleet chain files are gone, so a chain is written once instead of per
  agent. Activation state is now `{ fleet, fleetActivatedAt }` and a selection
  is a single fleet ID; `use` replaces an unreadable prior state file instead of
  refusing to run. See
  [ADR 0004](docs/adr/0004-fleet-line-separation.md).
- Add the `lines` command and `show <$line>`, including the fleet agents that
  bind each line, and print resolved chains in `list` and `show <fleet>`.
- Update `doctor` to inspect the shared line catalog independently, to treat
  provider/model/variant gaps in lines the selected fleet uses as errors and
  other gaps as warnings, and to report `LINE_INVALID`, `LINES_*`, and
  `FLEET_INVALID` locations.
- Bootstrap the public `agents-fleet` TypeScript package with fleet and line
  schemas, validation, state management, CLI, OpenCode V2 plugin, and a generic
  software-team example.
- Add the minimal zero-cost `free` fleet using
  `opencode/muse-spark-1.3-contributor-free`, and make initialization discover
  and rewrite schema references for every bundled fleet and line.
- Add the read-only `doctor` command and exported diagnostics API for
  configuration, state, context, schema, and OpenCode V2 catalog compatibility
  checks, with human/JSON output and CI-friendly exit codes.
