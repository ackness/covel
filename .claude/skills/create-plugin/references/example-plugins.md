# Current examples

Use maintained packages rather than copied historic manifests.

Main checkout:

- `templates/plugin-with-tools`: inline grouped agent runtime and a declared entry tool.
- `templates/plugin-multi-runtime`: root contributions plus child `RUNTIME.md` files, own data, and manual invocation.
- `plugins/memory`: detached `turn-digest@1`, `prompt.segment@1`, and public block-definition services.
- `plugins/history-compaction`: `history.compact@1` implementation.
- `plugins/world-init`: World Model schema initialization and own public services.

Community checkout (`covel-plugins`, https://github.com/covel-ai/covel-plugins):

- `examples/story-note`: declared context hook with no store access; installed ID is `example-story-note`.
- `examples/notes-workbench`: RPC action + slash command, scoped data writes, optional service discovery.
- `examples/note-format-clean` and `note-format-outline`: `examples.note-format@1` service providers.
- `examples/jev-choice-demo`: required `scene-prompts@1`/`narrative-engine@1` inputs and an evaluation service.
- `plugins/openai-image-gen` and `dashscope-image-gen`: `media.image-flow@1`, explicit tools, event followers, generic gallery/job props.
- `plugins/mimo-tts`: declared speech wire, detached post-turn narration, manual playback.

Preserve ownership declarations when adapting an entry. Change package and runtime IDs consistently, including UI actions and extension output. A public contract may be shared by competing providers; private data namespaces are not a cross-plugin interface.
