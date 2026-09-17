# agents-fleet

> **Pre-release:** version `0.1.0-dev.0`; configuration and plugin APIs may
> change. Supported Node.js versions are `^22.22.2 || ^24.15.0 || >=26.0.0`.

`agents-fleet` is a small TypeScript package for selecting validated agent
architectures and model fleets for OpenCode V2. An **architecture** owns the static agent roster,
prompts, and memory bindings. A **fleet** owns only ordered model chains for
the architecture's route slots. A setup-time activation snapshot keeps a
running service consistent while the files change on disk.

## Quickstart

```sh
npm install
npm run build
node dist/cli.js init ./my-agents-fleet
AGENTS_FLEET_HOME="$PWD/my-agents-fleet" node dist/cli.js validate
AGENTS_FLEET_HOME="$PWD/my-agents-fleet" node dist/cli.js list
AGENTS_FLEET_HOME="$PWD/my-agents-fleet" node dist/cli.js use budget --no-restart
```

The bundled [`software-team`](examples/software-team/) configuration is
illustrative. Its model IDs are examples and provider credentials are never
managed by this project.

## Commands and integration

Use `agents-fleet --help` for the complete CLI. Install the default OpenCode V2
plugin from `dist/plugin.js` (or the package `agents-fleet/plugin`) in your
OpenCode configuration. This pre-release is source-install oriented and is not
published to npm. See [configuration](docs/configuration.md) and
[OpenCode integration](docs/opencode-integration.md).

## Links

- [Concepts](docs/concepts.md) · [CLI](docs/cli.md) · [Security model](docs/architecture-security.md)
- [Contributing](CONTRIBUTING.md)
- [Forgejo](https://git.lucianonery.dev/LucianoNeryDev/agents-fleet) ·
  [GitHub](https://github.com/LucianoNeryDev/agents-fleet) ·
  [Codeberg](https://codeberg.org/LucianoNeryDev/agents-fleet)
