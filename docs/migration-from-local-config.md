# Migrating from a local configuration

This public package deliberately does not import or discover any legacy local
configuration. Create a root with `agents-fleet init`, compare its generic fleet
and lines with your own setup, and manually copy only the settings you intend to
publish.

Keep agent topology and prompt/context bindings in the fleet file. Put only
provider/model chains in the shared line catalog, and let agents reference them
by name. Select the result with `agents-fleet use <fleet> --no-restart`, inspect
it, then restart OpenCode deliberately. Existing sessions may need replacement
after a fleet switch.

If you are migrating from the earlier architecture/fleet layout, the mapping is
direct: an `architecture.json` becomes `fleets/<id>/fleet.json`, each agent's
`routeSlot` becomes a `line` reference, and each old route-slot chain becomes a
line file in the shared `lines/` catalog. Slot names that described a cost tier
(`heavy`, `cheap`, `frontier`) are usually the right line names.

Do not copy credentials, private prompts, personal memory, absolute paths, or
service-specific assumptions into a public repository. Provider authentication
belongs to OpenCode's own configuration.
