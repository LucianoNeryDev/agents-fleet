# CLI

Build first with `npm run build`, then run `agents-fleet` from `dist/cli.js` or
the installed binary.

- `init [directory]` copies the generic example and never overwrites existing
  entries.
- `validate [directory]` validates every architecture and fleet.
- `current` prints `architecture/fleet`.
- `list` prints architectures and nested fleets; `list <architecture>` prints
  only that architecture's fleets.
- `show <architecture>` prints its roster; `show <fleet>` uses the active
  architecture; `show <architecture>/<fleet>` prints route details.
- `use <fleet|architecture/fleet>` validates and persists a selection, then
  runs `opencode service restart`. Add `--no-restart` to skip it.

`--config` overrides the config root and `--state` overrides the state file.
`OPENCODE_BIN` selects one executable path/name; it is passed directly to
`spawnSync` with no shell. A failed restart does not roll back state and warns
that the running service may be stale.

Names are colored only for terminals. `NO_COLOR` wins over `FORCE_COLOR`; use
`FORCE_COLOR=1` or `FORCE_COLOR=0` to override TTY detection. Architecture and
fleet names are magenta, agents cyan, primaries green, fallbacks yellow, and
separators dim.
