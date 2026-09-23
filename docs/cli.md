# CLI

Build first with `npm run build`, then run `agents-fleet` from `dist/cli.js` or
the installed binary.

- `init [directory]` copies the generic example and never overwrites existing
  entries.
- `validate [directory]` validates every fleet and line file.
- `current` prints the active fleet ID.
- `list` prints fleets and the line each enabled agent binds.
- `lines` prints the shared line catalog with every resolved chain.
- `show <fleet>` prints its roster, the lines its agents bind, and the resolved
  chains; `show <$line>` prints one line's chain and the fleet agents using it.
- `use <fleet>` validates and persists a selection, then runs
  `opencode service restart`. Add `--no-restart` to skip it.
- `doctor [directory]` performs read-only authoring and OpenCode V2 catalog
  diagnostics. Add `--offline` to avoid subprocesses or `--json` for one
  machine-readable report. See [Diagnostics](diagnostics.md).

`--config` overrides the config root and `--state` overrides the state file.
`OPENCODE_BIN` selects one executable path/name; it is passed directly to
`spawnSync` with no shell. A failed restart does not roll back state and warns
that the running service may be stale.

Doctor exits `0` when requested checks complete without errors, `1` for
completed diagnostics with errors, and `2` when requested live OpenCode checks
cannot complete. Warnings do not make the command fail. `OPENCODE_BIN` applies
to both restart and doctor, and is always invoked directly without a shell.

Names are colored only for terminals. `NO_COLOR` wins over `FORCE_COLOR`; use
`FORCE_COLOR=1` or `FORCE_COLOR=0` to override TTY detection. Fleet names are
magenta, agent IDs cyan, line references blue, primaries green, fallbacks
yellow, and separators dim.

The bundled initialization contains the `free` and `software-team` fleets. With
no state file, `current` selects `free`; use an explicit selection such as
`use software-team --no-restart` when choosing the software-team fleet.
