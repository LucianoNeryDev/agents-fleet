# Diagnostics

`agents-fleet doctor` checks authoring errors and, by default, compares the
configuration with a running OpenCode V2 service. It is read-only: it does not
create activation state, edit configuration, restart OpenCode, contact model
providers, or send model requests.

```sh
agents-fleet doctor
agents-fleet doctor ./config --offline
agents-fleet doctor --json > doctor.json
```

`--config` and `--state` provide the same explicit overrides as other
commands. `--offline` disables every subprocess and performs configuration-only
checks. `--json` writes exactly one versioned report to standard output for CI
or other tools.

## Checks

Offline diagnostics validate:

- every architecture and every fleet file, including route-slot agreement;
- persisted or deterministic architecture/fleet selection without writing it;
- context-source containment, presence, readability, and byte limits; and
- local relative `$schema` references without fetching remote schemas.

Live diagnostics invoke the executable selected by `OPENCODE_BIN`, or
`opencode` by default, with no shell. They check `--version` plus the V2
`agent.list`, `model.list`, and `provider.list` API operations. Only agent IDs,
provider IDs, model IDs, and model variant IDs are retained. Raw records,
headers, settings, stdout, and stderr are never copied into the report.

The selected architecture's enabled agents must appear in the active catalog.
Selected-fleet provider, model, and variant gaps are errors; gaps referenced
only by inactive fleets are warnings. Repeated references are grouped.

## Severities and exit codes

- `error` — configuration or selected runtime compatibility must be fixed.
- `warning` — authoring guidance or an inactive-fleet compatibility gap.
- `info` — confirmed scope, selection, or a non-failing condition.
- `skipped` — an intentional omission, such as `--offline`.

Exit status `0` means the requested checks completed without errors; warnings
are allowed. Status `1` means checks completed and found errors. Status `2`
means requested live checks could not complete because the executable failed,
timed out, or returned malformed data.

## Common fixes

- `CONFIG_INVALID` — run `agents-fleet validate`, then fix the first
  architecture, prompt, or containment error.
- `FLEET_INVALID` — make the fleet ID match its filename and provide exactly
  the enabled architecture's route slots.
- `STATE_INVALID` or `STATE_SELECTION_INVALID` — repair/remove stale state,
  then run `agents-fleet use <architecture>/<fleet>` after configuration is
  valid.
- `CONTEXT_*` — keep the path inside its architecture, check `required`, and
  keep the file within `maxBytes`.
- `SCHEMA_*` — point `$schema` to the copied local schema or a stable HTTPS
  schema URL.
- `AGENT_MISSING` — define the selected architecture's agents statically in
  OpenCode before activation.
- `PROVIDER_MISSING`, `MODEL_MISSING`, or `VARIANT_MISSING` — choose a catalog
  entry available in OpenCode or configure the corresponding provider/model.
- `OPENCODE_*` — verify `OPENCODE_BIN`, the running V2 service, and API output;
  use `--offline` when only file checks are required.

## Limits

OpenCode's agent API exposes the transformed active catalog. Doctor can verify
the selected architecture, but it cannot prove that agents removed by the
active transform are present in the underlying static superset for every
inactive architecture. Catalog presence also does not prove credentials,
quota, capacity, or that a provider request will succeed.

Reports use logical configuration locations and redact the configuration root
from loader errors. They contain no timestamps, file contents, provider
credentials, or raw OpenCode records.
