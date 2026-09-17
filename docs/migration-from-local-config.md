# Migrating from a local configuration

This public package deliberately does not import or discover any legacy local
configuration. Create a root with `agents-fleet init`, compare its generic
architecture and fleets with your own setup, and manually copy only the
settings you intend to publish.

Keep agent topology and prompt/context bindings in the architecture file. Put
only provider/model chains in fleet files. Select the result with
`agents-fleet use <architecture>/<fleet> --no-restart`, inspect it, then restart
OpenCode deliberately. Existing sessions may need replacement after an
architecture switch.

Do not copy credentials, private prompts, personal memory, absolute paths, or
service-specific assumptions into a public repository. Provider authentication
belongs to OpenCode's own configuration.
