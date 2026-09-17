# Contributing and development

Use Node `^22.22.2`, `^24.15.0`, or `>=26.0.0`, matching the pinned OpenCode V2
development SDK's transitive runtime requirement. The SDK is an integration
dependency, not a provider or credential manager. This pre-release is intended
to be installed from source; no npm release is published yet.

```sh
npm install
npm run build
npm run typecheck
npm test
npm run validate:examples
```

Tests use Node's built-in test runner and temporary roots. CLI tests must set a
fake `OPENCODE_BIN` and must never restart a real service. Keep changes
modular, update schemas/docs for public contract changes, and do not commit
generated `dist/` or credentials.
