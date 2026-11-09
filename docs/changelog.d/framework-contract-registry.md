### Breaking

- **A story agent without an output schema submits story segments.** A schema-less `io.visibility: story` agent used to get a host default of `{narrativeOutput, yield?}`. It now submits the `narrative-engine@2` story shape (`segments`, optional `cues` and `yield`). A submission with only `narrativeOutput` is sent back for repair. Community story agents need no manifest change, only prompts that ask for segments. See [Without an output schema](../reference/plugins.md#default-output-schema).
- **Only an automatically scheduled story runtime provides `narrative-engine@2`.** A manual, event or sub-agent story runtime that writes `io.output.contract` is disabled, and so is a story runtime that names any other output contract. Remove the field.
- **A session admits one story package.** Two packages that both provide `narrative-engine@2` are mutually exclusive without writing `conflicts`. The second one is refused with `single-provider-conflict`, and a replacement the player picks still replaces the default narrator. A written `conflicts: [narrative-engine@2]` is ignored. Sessions that had two story packages active keep only one; nothing has to be recreated.

### Changed

- **The framework owns the story contract.** An automatically scheduled story runtime provides `narrative-engine@2` and submits its schema without declaring `io.output.contract`, `io.output.schema`, root `contracts` or `conflicts`. `pnpm validate:plugin` warns when a package still writes them. A declared copy of the schema must match the framework's. The bundled Storyteller and Chat Storyteller drop these declarations and their schema files. See [Framework-owned contracts](../reference/plugins.md#framework-contracts).
- **Presentation and auto-advance read the execution's own story.** A presentation selector gets the one successful public story of its execution. Auto-advance follows the one committed top-level story of any `io.visibility: story` runtime, whether or not it names a contract.
