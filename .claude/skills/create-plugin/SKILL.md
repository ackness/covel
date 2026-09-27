---
name: create-plugin
description: Create or update installable Covel plugins using the current grouped manifest, runtime, service, extension, and UI contracts.
---

# Create a Covel plugin

Implement the requested plugin in the user's chosen repository. In the main checkout use `plugins/<id>`; in the community checkout use `plugins/<id>` for optional features and `examples/<id>` for instructional packages. Do not edit an installed user copy unless the user requested that target.

Read [manifest fields](references/plugin-schema.md) before implementation. Use the current contract only, preserving existing plugin and runtime identities unless the requested change requires new ones. Root `PLUGIN.md` is required and contains `id`, `kind`, package contracts, and `contributes`. A single inline `runtime` or child `runtimes/<id>/RUNTIME.md` supplies executable behavior. Child `PLUGIN.md` and old flat authoring fields are rejected.

For same-execution inputs, bind public contracts under `io.inputs`. Reusable operations use declared services; kernel customization uses declared extensions. Do not read another plugin's store. All plugin contexts are scoped to their own session/plugin, including built-ins; trusted status does not grant a raw DataStore. Character/schema/lore state comes through `ctx.world`, and writes use proposals or handler effects.

Each entry registration needs a matching declaration in `contributes`. RPC actions and slash commands are separate. Use `covel.toolkit` for local tools and validators, `covel.registerService` for services, and `covel.provideExtension(point, id, {handler})` for extensions. Registration factories should perform registration only; defer I/O to invocation handlers.

Use `ctx.images.generate` and `ctx.speech.generate`/`transcribe` for media. An image-flow entry declares `media.image-flow@1`, returning its own full `entryRuntimeId` and `assetRuntimeIds`; the host attributes provider ownership. This point admits one provider per session. UI uses generic `MediaGallery`, `JobList`, `CandidateList`, or `EntryList` with explicit data and field selectors; no component should infer or fetch another plugin's private namespace.

Standalone packages require `package.json` (`type: module`), root manifest, executable ESM JavaScript, README, and an authorized license. The installer does not install npm dependencies or run build scripts. Bundle helper libraries such as `@covel/plugin-handlers-utils` into the released plugin and preserve their licenses. Do not ship workspace dependencies or sibling-plugin imports. Agent runtime bodies hold prompts; function handlers return explicit success/skipped/failed/blocked results. Preserve cancellation, bounded work, and successful-commit-only domain writes.

Read references relevant to the task:

- [Runtime context](references/runtime-context.md)
- [Tools](references/tool-factory.md)
- [UI](references/ui-components-quickref.md)
- [Examples](references/example-plugins.md)
- [Testing](references/plugin-testing.md)
- [Model slots](references/llm-toml-slots.md) and [provider wires](references/provider-quirks.md)

Validate manifests with the main checkout's `pnpm validate:plugin <package-dir>`, run focused handler/registration tests, and verify copied release files import without workspace dependencies. The community repository also has `pnpm check:covel` for the real loader, registration declarations, and generic UI props. Update bilingual user documentation, settings instructions, network/data behavior, tests, and packaging together. Publishing or installing outside the authorized workspace requires the user's explicit task authorization.
