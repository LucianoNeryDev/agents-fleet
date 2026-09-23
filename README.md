# agents-fleet

> **Pre-release:** version `0.1.0-dev.0`; configuration and plugin APIs may
> change. Supported Node.js versions are `^22.22.2 || ^24.15.0 || >=26.0.0`.

`agents-fleet` is a small TypeScript package for selecting validated agent
**fleets** and shared model **lines** for OpenCode V2. A fleet owns the static
agent roster, prompts, and context-memory bindings. A line is a named model
chain — a primary plus optional fallbacks — defined once in a shared catalog and
referenced from agents as `$name`, so the same chain is never repeated per
agent. A setup-time activation snapshot keeps a running service consistent while
the files change on disk.

```text
lines/frontier.json          openai/gpt-5-codex -> anthropic/claude-sonnet-4 -> openrouter/openai/gpt-5-codex
lines/economy.json           google/gemini-2.0-flash -> openai/gpt-4.1-mini
fleets/software-team/fleet.json
  build     -> $frontier
  coder     -> $standard
  reviewer  -> $economy
```

## Quickstart

```sh
npm install
npm run build
node dist/cli.js init ./my-agents-fleet
AGENTS_FLEET_HOME="$PWD/my-agents-fleet" node dist/cli.js validate
AGENTS_FLEET_HOME="$PWD/my-agents-fleet" node dist/cli.js doctor --offline
AGENTS_FLEET_HOME="$PWD/my-agents-fleet" node dist/cli.js list
AGENTS_FLEET_HOME="$PWD/my-agents-fleet" node dist/cli.js use software-team --no-restart
```

The bundled [`software-team`](examples/software-team/) configuration is
illustrative. Initialization includes the `free` and `software-team` fleets plus
the `economy`, `free`, `frontier`, and `standard` lines; when no activation state
exists, the deterministic default is `free`. The free fleet binds the single
zero-cost `$free` line to every enabled agent, routing them to the exact OpenCode
model `opencode/muse-spark-1.3-contributor-free` (Muse Spark 1.3 Free), an active
model discovered from the current OpenCode catalog. OpenCode remains responsible
for provider authentication and model availability; this project never manages
credentials.

## Commands and integration

Use `agents-fleet --help` for the complete CLI. Install the default OpenCode V2
plugin from `dist/plugin.js` (or the package `agents-fleet/plugin`) in your
OpenCode configuration. The read-only `doctor` command validates authoring and
can compare agents, providers, models, and variants with a running OpenCode V2
service. This pre-release is source-install oriented and is not published to
npm. See [configuration](docs/configuration.md),
[diagnostics](docs/diagnostics.md), and
[OpenCode integration](docs/opencode-integration.md).

## Links

- [Concepts](docs/concepts.md) · [CLI](docs/cli.md) · [Diagnostics](docs/diagnostics.md) · [Security model](docs/architecture-security.md)
- [Contributing](CONTRIBUTING.md)
- [Forgejo](https://git.lucianonery.dev/LucianoNeryDev/agents-fleet) ·
  [GitHub](https://github.com/LucianoNeryDev/agents-fleet) ·
  [Codeberg](https://codeberg.org/LucianoNeryDev/agents-fleet)
