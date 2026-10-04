---
name: create-plugin
description: Create or update installable Covel plugins using the current grouped manifest, runtime, service, extension, and UI contracts. Use when the user wants a new plugin, gameplay mechanic, runtime, tool, or plugin UI panel, or asks to change an existing plugin's manifest or behavior.
---

# Create a Covel plugin

Contracts live in `docs/`, kept in sync with the code: manifest fields in
`docs/reference/plugins.md`, authoring in `docs/guide/plugin-authoring.md`, UI
components in `docs/reference/ui-components.md`, model slots in
`docs/reference/slots.md`, testing in `docs/guide/plugin-testing.md`. The
references in this skill are agent-oriented guides; when they disagree with the
docs or the schemas, the docs and schemas win.

## Workflow

### 1. Pick the target

In the main checkout, plugins live in `plugins/<id>`. In the community checkout
(`covel-plugins`), optional features go in `plugins/<id>` and instructional
packages in `examples/<id>`. Do not edit an installed user copy unless the user
asked for that target. Preserve existing plugin and runtime identities unless the
change requires new ones.

### 2. Scaffold

Start from a maintained template rather than a copied historic manifest:

```bash
node scripts/create-plugin.js <id> -t ./plugins                 # multi-runtime workbench
node scripts/create-plugin.js <id> -t ./plugins -r foo:function,bar:agent
node scripts/create-plugin.js <id> --with-tools                 # single runtime + tools/
```

Without `-t` (or `--with-tools`) the scaffolder writes to the user plugin
directory (`~/.covel/plugins`), not the repository. See
[examples](references/example-plugins.md) for packages that show each pattern.

### 3. Declare the manifest

Read [manifest fields](references/plugin-schema.md) first. Root `PLUGIN.md` is
required and holds `id`, `kind`, package contracts, and `contributes`. A single
inline `runtime` or child `runtimes/<id>/RUNTIME.md` files supply executable
behavior; child `PLUGIN.md` files and old flat authoring fields are rejected.
Declare scheduling with `stage` plus `needs` / `after` edges, and `io.visibility`.

Write `PLUGIN.md`, `RUNTIME.md` and `ui/*.json` in English: labels, tool
descriptions, UI text, and the prompt body. Put label translations
(`displayName`, `description`, `label`, `title`, `summary`, `about`) in
`locales/<locale>.yaml`, one section per manifest file, and UI text translations
in the same file under `messages` (English text, then its translation). Code
writes English too and reads the same `messages` through `translate(ctx, "…")`
(session language) and `labelText(ctx, "…")` (every language, for the client).
An
inline `{ zh, en }` map in a manifest or a UI spec fails `pnpm validate:plugin`,
and a bundled plugin needs a Chinese translation for every UI text. The
Simplified Chinese prompt is `PLUGIN.zh.md` / `RUNTIME.zh.md` with an empty
frontmatter; a bundled plugin must ship it for every prompt a model reads, then
run `pnpm prompts:lock`. No other language has a prompt file. See
`docs/reference/i18n.md`. Write the body as `docs/guide/prompt-style.md` says:
short imperative sentences, one term for one thing, each rule once, `must` /
`must not` / `can`, and tone or examples under a `## Voice` heading.

For same-execution inputs, bind public contracts under `io.inputs`. Reusable
operations use declared services; kernel customization uses declared extensions.
Never read another plugin's store: every plugin context, built-ins included, is
scoped to its own session and plugin, and trusted status grants no raw DataStore.
Character, schema, and lore state come through `ctx.world`; writes go through
proposals or handler effects.

### 4. Implement

- Every entry registration needs a matching declaration in `contributes`. RPC
  actions and slash commands are separate.
- Use `covel.toolkit` for local tools and validators
  ([tools](references/tool-factory.md)), `covel.registerService` for services, and
  `covel.provideExtension(point, id, {handler})` for extensions. Registration
  factories only register; defer I/O to invocation handlers.
- Agent runtime bodies hold prompts. Function handlers return explicit
  success / skipped / failed / blocked results
  ([runtime context](references/runtime-context.md)). Preserve cancellation,
  bounded work, and successful-commit-only domain writes.
- Media goes through `ctx.images.generate` and `ctx.speech.generate` /
  `transcribe`. An image-flow entry declares `media.image-flow@1`, returning its
  own full `entryRuntimeId` and `assetRuntimeIds`; the host attributes provider
  ownership, and this point admits one provider per session
  ([model slots](references/llm-toml-slots.md),
  [provider wires](references/provider-quirks.md)).
- UI uses the generic `MediaGallery`, `JobList`, `CandidateList`, or `EntryList`
  with explicit data and field selectors; no component infers or fetches another
  plugin's private namespace.

### 5. Package standalone plugins

Standalone packages need `package.json` (`type: module`), the root manifest,
executable ESM JavaScript, a README, and an authorized license. The installer does
not install npm dependencies or run build scripts, so bundle helper libraries such
as `@covel/plugin-handlers-utils` into the release and preserve their licenses. Do
not ship workspace dependencies or sibling-plugin imports.

### 6. Validate

```bash
pnpm validate:plugin plugins/<id>       # manifest + cross-runtime checks
pnpm --filter <package-name> test       # focused handler/registration tests
pnpm check:plugins                      # plugin i18n + README gates
pnpm check:prompts                      # English prompts and their Chinese variants
```

Follow [testing](references/plugin-testing.md) for which layers to cover. Verify
copied release files import without workspace dependencies. The community
repository also has `pnpm check:covel` for the real loader, registration
declarations, and generic UI props.

### 7. Sync docs

A bundled plugin added or changed in the main checkout updates
`docs/reference/plugins.md` in the same change (see the documentation sync list
in `AGENTS.md`). Update bilingual user documentation, settings instructions,
network/data behavior, and tests together. Publishing or installing outside the
authorized workspace requires the user's explicit authorization.
