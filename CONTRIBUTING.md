# Contributing

The project is pre-release. Read the README and `docs/` before changing a
public contract; [docs/contributing-development.md](docs/contributing-development.md)
has the Node versions and the test conventions in detail.

## Keep it generic

agents-fleet is a public, generic TypeScript package for OpenCode V2. Keep
configuration, examples, tests and documentation free of secrets, credentials,
local or private paths, private identities, persona-specific content and client
information.

## Verify

Install dependencies with `npm install`, then run the complete verification
before opening a pull request:

```sh
npm run build && npm run typecheck && npm test && npm run validate:examples
```

## Changes

Use focused changes, add Node built-in tests for behavior, and update the
relevant public documentation and changelog. Do not commit generated `dist/`.
