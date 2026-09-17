# Contributing

The project is pre-release. Read the README and `docs/` before changing a
public contract. Keep configuration and examples generic, never add secrets,
credentials, private paths, or persona-specific content.

Install dependencies with `npm install`, then run:

```sh
npm run build && npm run typecheck && npm test && npm run validate:examples
```

Use focused changes, add Node built-in tests for behavior, and update the
relevant public documentation and changelog. Do not commit generated `dist/`.
