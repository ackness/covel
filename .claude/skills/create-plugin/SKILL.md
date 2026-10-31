---
name: create-plugin
description: Create or update installable Covel plugins using the current grouped manifest, runtime, service, extension, and UI contracts. Use when the user wants a new plugin, gameplay mechanic, runtime, tool, or plugin UI panel, or asks to change an existing plugin's manifest or behavior.
---

# Create a Covel plugin

Contracts live in `docs/`, kept in sync with the code: manifest fields in
`docs/reference/plugins.md`, authoring in `docs/plugins/essentials.md`, UI
components in `docs/reference/ui-components.md`, model slots in
`docs/reference/slots.md`, testing in `docs/plugins/testing.md`. The
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

Every mode starts `PLUGIN.md` at version `0.1.0`; the version lives only there (a `--with-tools` `package.json` has none). The default mode writes no `package.json`: the directory name is the plugin ID, and the loader runs the package's `.js` files as ES modules. Generated runtime case files include `$schema`; `name` and `runtimeId` are required, and unknown case/expectation/artifact fields fail before execution.

The tools scaffold uses stable TypeScript 7.0.2 and Zod 4.6.7 or later compatible versions. Keep its Zod minimum aligned with the host SDK peer dependency; older declarations fail recursive JSON inference under TypeScript 7.1. Runtime dependencies still come from the host. Keep Vitest aligned with the workspace using the current template manifest.

The default analyst runs automatically in `post-turn` and consumes the current narrative binding. Function notes remain manual; generate keys through `ctx.random` and timestamps in code.

### 3. Declare the manifest

Read [manifest fields](references/plugin-schema.md) first. Root `PLUGIN.md` is
required and holds `id`, `kind`, package contracts, and `contributes`. A single
inline `runtime` or child `runtimes/<id>/RUNTIME.md` files supply executable
behavior; child `PLUGIN.md` files and old flat authoring fields are rejected.
Declare scheduling with `stage` plus `needs` / `after` edges; set
`io.visibility: story` only on a narrative provider (every other runtime is
`system`, the default). A narrative provider returns story segments with
speaker names; declare `io.output.schema: contract:narrative-engine@2` so the
model is asked for them (story output in `docs/reference/plugins.md`). Leave
out fields written with their default value.

Write `PLUGIN.md`, `RUNTIME.md` and `ui/*.json` in English: labels, tool
descriptions, UI text, and the prompt body. Put label translations
(`displayName`, `description`, `label`, `title`, `summary`, `about`, `placeholder`) in
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
`docs/reference/i18n.md`. Write the body as `docs/plugins/prompt-style.md` says:
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
  belongs in the entry factory. Defer session work to invocation handlers; if
  initialization acquires resources, register `covel.onDispose` cleanup immediately
  and use the activation `covel.signal` (see `docs/reference/plugin-extensions.md`).
- Agent runtime bodies hold prompts. Function handlers return explicit
  success / suspended / skipped / failed results
  ([public HandlerResult](../../../packages/plugin-handlers-utils/src/handler-result.ts),
  [runtime context](references/runtime-context.md)). Preserve cancellation,
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

Standalone packages need the root manifest, executable ESM JavaScript, a README,
and an authorized license. A `package.json` is optional; when present it says
`"type": "module"` and carries no `version`. Without an `id` in `PLUGIN.md`, an
installed package takes the name of its folder (the archive's top-level folder or
the repository directory), then the `package.json` name. The installer does
not install npm dependencies or run build scripts, and it rejects nonempty
`dependencies`. The host provides `@covel/plugin-handlers-utils` and `zod` to
every plugin: import them directly and list them only under `devDependencies`.
Bundle any other library into the release and preserve its license. Do not ship
workspace dependencies or sibling-plugin imports.

### 6. Validate

Sync your own entry's declarations with `pnpm plugin:extract plugins/<id>` (executes code with your permissions); use `--check` for CI, and maintain `extensions` / `commands` metadata yourself. See [local code](../../../docs/plugins/local-code.md#4-写入口文件).

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
`docs/reference/plugins.md`, its theme page under `docs/builtin/`, and the tables
in `docs/builtin/index.md` in the same change (see the documentation sync list
in `AGENTS.md`). Update bilingual user documentation, settings instructions,
network/data behavior, and tests together. Publishing or installing outside the
authorized workspace requires the user's explicit authorization.
