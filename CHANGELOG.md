# Changelog

## Unreleased

- Bootstrap the public `agents-fleet` TypeScript package with architecture and
  fleet schemas, validation, state management, CLI, OpenCode V2 plugin, and a
  generic software-team example.
- Add the minimal zero-cost `free/free` example using
  `opencode/muse-spark-1.3-contributor-free`, and make initialization discover
  and rewrite schema references for every bundled architecture and fleet.
- Add the read-only `doctor` command and exported diagnostics API for
  configuration, state, context, schema, and OpenCode V2 catalog compatibility
  checks, with human/JSON output and CI-friendly exit codes.
