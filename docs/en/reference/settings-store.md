# SettingsStore and model settings

> [中文版](../../reference/settings-store.md)

This page describes how Covel stores settings: where they live, what happens when several windows change them at once, why API keys use a separate channel, and how the model settings pages save. It is for people who maintain the settings UI, write a settings backend, or debug a setting that was not saved.

SettingsStore is the settings storage of the `@covel/settings` package. It does four things: it registers a schema for each setting, holds the current values in memory, notifies subscribers, and writes the values to persistent storage.

Three basic facts:

- **The current device decides where settings are stored.** With Electron IPC it is the personal file `settings.json`; otherwise it is always the browser's localStorage.
- **API keys use a separate secrets channel** and are not stored with ordinary settings.
- **A few settings are kept by the server.** They are marked `scope: "server"`; see [Settings the server acts on](#settings-the-server-acts-on). This is the only exception.

The server's `/api/config/info` only discovers administration capabilities. Neither `COVEL_HOME` nor `isDesktop` switches a browser's settings to a shared server file. Failed discovery does not block local initialization.

## Persisted format and data that cannot be used

Ordinary persisted settings accept only `schemaVersion: 2`, and must contain `revision`, `savedAt`, and `entries`. LocalStorage, REST, and desktop IPC share this one validation.

Data this build cannot use is not migrated. The app keeps a copy, makes the settings usable again, and says so once inside the app. There are two cases:

**The whole bundle is unusable.** This covers an earlier format (`v1`), no version (`unversioned`), and text that is not a bundle (`damaged`).

- It is moved aside unchanged during load, and the settings start from their defaults.
- The browser stores it as `covel:settings.<label>.bak`; the desktop shell renames the file to `settings.<label>.bak.json` at startup.
- A bundle written by a later build is not this case: reads and replacement writes are rejected, the content is kept, and SettingsStore is read-only.

**Single values are unusable.** The schema currently registered for a key refuses the stored value, for example an option removed by an upgrade, or a plugin setting with a new range.

- The store first keeps a full copy (`covel:settings.conflict.bak` / `settings.conflict.bak.json`).
- It then removes those keys from storage. They read their defaults and the other settings are unchanged.
- A key registered after the load (a plugin setting) is handled the same way. A write issued before that is done waits behind it.

**About the copies.**

- A copy never replaces an existing copy. A timestamp is added to the name; a counter follows when the same millisecond still collides.
- When the copy cannot be written, or the backend has no `backupBundle`, nothing is dropped and SettingsStore stays read-only.
- The notice comes through `subscribeRepairs` and `SettingsBackendAdapter.takeArchivedBundle()`.
- The copies can be viewed and downloaded in Settings → Data (`listBackups` / `readBackup`; desktop IPC `covel:settings:backup`, `covel:settings:backups`, `covel:settings:read-backup`).
- The secrets channel is not affected, and a copy holds no API keys.

The settings import/export format `SettingsExportBundle.schemaVersion: 1` is a separate, current format and is not affected by these limits.

## Settings the server acts on

Every setting has a scope:

| Scope                  | What it is                                                                               | Who keeps it                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `client` (the default) | A preference of one device: theme, layout, language, the models and keys of that browser | That device                                                   |
| `server`               | A setting the server itself carries out                                                  | The server; every browser of the install reads the same value |

A `server` setting is declared in two places: the registry entry has `SettingEntry.scope: "server"`, and the same key has a definition in `SERVER_SETTINGS` (`packages/shared/src/env/server-settings.ts`: schema, default, and the environment variable that overrides it). A test fails when the two differ.

The keys are `diagnostics.traceRetention` (Settings → General → "Keep diagnostic traces": `7` / `30` / `90` / `keep`, default `30`) and `trust.sources` (Settings → Install & manage → "Trusted sources": an array of GitHub owners or repositories, default `[]`, overridden by `COVEL_TRUSTED_SOURCES`). See [plugin installation](./plugin-installation.md#trusted-sources) for syntax and approval conditions.

- **Where it is stored.** In the server's database, in the `server_settings` table of the DataStore (`listServerSettings` / `setServerSetting` / `deleteServerSetting`, covered by the store contract suite).
  - The desktop app and a self-hosted web deployment use the same mechanism.
  - It survives a read-only or replaced home directory.
  - Several server processes on one PostgreSQL database read the same value.
  - It is never written to `settings.json` or localStorage.
  - With `STORE_BACKEND=memory` it lasts only until the process exits.
- **Who may write.** Only the personal form: the one player owns the server. When the desktop shell set a token, `PUT /api/config/server-settings` also requires it. On browser-private and the `demo` / `commercial` tiers these settings belong to the operator and are set through the environment; a write returns `403` and the control is shown as locked.
- **Precedence.** The operator's environment variable, then the stored value, then the default. A key fixed by the environment is not settable, and a write of it returns `409`.
- **Validation.** A write may contain known keys only, and each value must pass the schema in the definition. One invalid entry rejects the whole request and nothing is written.
- **Effect.** The server reads from an in-memory copy. That copy is filled before the first sweep and replaced on every write. A change therefore applies at the next commit or sweep, without a restart. Other server processes on the same database follow within 30 seconds.

In the Web app, SettingsStore routes these keys to the server (`ServerSettingsChannel`, `GET` / `PUT /api/config/server-settings`). Desktop and web behave the same:

- **Read and write interface.**
  - `store.get(key)` returns the value in force as the server reports it. It may be an operator's value that the options do not offer.
  - `store.has(key)` is true when a stored value is in force.
  - `store.set` / `store.clear` write to the server.
  - `store.serverSetting(key)` returns `{ status, value, source, settable }`. `status` is `pending` until the server has answered, and `unavailable` when it could not be asked.
- **When a control is disabled.** A control of such a setting is disabled while `pending` or `unavailable`, and when `settable` is false, with a line that says why. It therefore never offers a choice the server then refuses. Every generic widget honours this; no widget is written per setting.
- **Feedback on a write.** A write shows the new value at once. When the server refuses it or cannot be reached, the earlier value comes back and the "Could not save setting" toast shows the reason the server gave.
- **Other points.** The values are read again when the window regains focus. They do not block the load of the device's settings, and are not part of the settings export, the raw JSON editor or "Reset". A key of this scope found in the device's own storage is ignored.

Precedence and the trace sweep rules: [`env-registry.md`](./env-registry.md). The security boundary: [`security.md`](../internals/security.md#server-settings).

## Schema normalization

**The visible value is the schema's parsed result.** Registered non-secret settings expose the parsed result at all of these moments: load, dynamic registration, `set()`, `setMany()`, import, refresh, and rollback after a failed write.

- Nested `.default()` values and trimmed strings appear in `get()`, exports, and subscriber notifications.
- An explicit write persists the parsed result.
- Unregistered keys keep their original values.

**Filling defaults is not an edit.** Filling defaults during load or refresh does not trigger a save by itself. Revision conflict checks still compare the original snapshots the backend confirmed, so filling defaults is not mistaken for a remote edit.

What a setting schema must do: accept its own persisted output, and give the same result when normalization runs more than once. Reloads, repeated registration, and synchronization depend on this.

**Subscribers do not affect each other.** Key, global, and persistence-error subscriptions isolate an exception in each synchronous callback. A subscriber that throws:

- does not stop the other subscribers;
- does not turn a successful save into a failure;
- does not replace the real I/O error;
- leaves only a fixed diagnostic that contains no key, value, or original exception.

**A model-role binding selects one target.** `modelRef` means a local provider model, and `presetId` means a server-configured preset. A binding that carries both fields is rejected. Reading a binding never rewrites the configuration.

**How imports handle content that does not qualify.**

- Invalid custom themes in a settings backup are skipped one by one, and valid themes continue to load.
- A model configuration import accepts only the current export format `{ version: 2, providers: [...] }`, and sanitizes each current profile on its own. An unsupported file, or a nonempty file with no usable profile, shows an error and keeps the current configuration.
- The Data import preview checks each entry against its currently registered schema. Incompatible entries, and secrets misplaced in ordinary `entries`, cannot be selected for import. Unregistered ordinary keys can still be kept.
- A backup that contains only separate `keys` can also be imported.
- Import and reset report completion only after persistence succeeds. A failed save keeps the import preview and shows an error.

**The theme library and the appearance studio wait for the real result.** Their serial workflows await the actual success or rejection of `SettingsStoreApi.set()`. A widget setter also returns normally after it has handled an error, so it cannot be taken as successful persistence.

- A failed application does not clear overrides or the theme name, and does not report a complete import.
- A failed token edit or reset shows an error and reverts that failed draft and preview only, not edits made later.
- The fire-and-forget error handling of the global `useSetting` is unchanged.

## Generic setting controls

`widget: custom` is edited in a dedicated interface and does not create a placeholder on the General page. Desktop maintenance, provider imports, and package actions use a common result notice. A new notice cancels the old dismissal timer; refresh failures and empty installation results are also reported.

A registered setting without a purpose-built pane renders through the generic widgets (`apps/web/src/settings/widgets/`). General and each plugin's settings page work this way.

- **When a value is written.** Text, number, slider and secret controls keep a local draft and write on blur or Enter. A draft that is still open when the dialog closes is written too. They do not write on every key press, because that would validate every half-typed value and a number could not be retyped.
- **Numbers.** A number outside the declared `min` / `max` becomes the nearest allowed value. A value the schema rejects for being fractional is rounded. An empty or non-numeric draft restores the stored value. When both bounds are declared, the range is shown beside the description.
- **Use default.** A key the player has set (`store.has(key)`) shows "Use default", which calls `store.clear(key)`. Only this makes a plugin setting follow the world's `pluginSettings` or the manifest default again. A value that equals the default but was set explicitly still overrides the world.
- **Descriptions.** The description of a framework key comes from the Web catalogue (`settings.frameworkEntries.*`), and that of a plugin key from the manifest. Whether the registry entry repeats the description does not change what is shown.
- **The value a world gives.** A plugin settings page shows the value from the current world's `pluginSettings`: a key the player has not set takes it, and the page names the world. A value the registered schema refuses is not used, and the server does not use it either.

- **Model pane input.** Generation parameters and model prices also keep drafts. Number fields commit on blur or Enter; sliders commit on pointer release, key release or blur. Inputs remain available during saving, and consecutive commits merge into the latest saved settings in order.
- **Destructive actions.** Deleting a provider or model configuration, uninstalling a plugin, deleting a theme and resetting all settings require `requestConfirm`. Provider deletion clears its key and model role bindings; model configuration deletion clears only its bindings, keeping the key.
- **Read-only mode.** When settings have not loaded successfully, only controls that write settings are disabled. Viewing, exporting and downloading backups remain available; other maintenance operations keep their own permission checks. Exports contain currently readable settings and may be incomplete; they are not the original backups. Including keys still requires explicit opt-in.

**Toasts.** Toasts render under `document.body`, above every dialog. A click on a toast does not close the dialog under it.

**The Configuration files page.** It edits the raw configuration as text: the settings of this device (JSON, without secrets), and the files the server offers — `llm.toml`, and `config.toml` in desktop mode (see `/api/config/raw` in the [API reference](./api.md)). When the settings JSON is saved:

- Each entry is checked against its registered schema.
- `replaceEntries(entries, expectedEntries)` replaces the complete ordinary snapshot in one operation. Deleted keys return to their defaults.
- Any addition, deletion, or modification made elsewhere since the editor loaded causes a conflict. The editor must be reloaded before saving, so the changes of other windows are not overwritten.
- A copy is kept before the save (`covel:settings.edit.bak` / `settings.edit.bak.json`). An earlier copy can also be loaded into the editor and saved.

**The Operator Access page.** It appears only where it has a use:

- It is hidden when `/api/health` reports `operatorTokenRequired: false` and this browser holds no token.
- It stays while the server has not answered, so that the operator of a hosted deployment has a place to enter the token.

**Language lists** name each language in that language.

## Multiple instances and synchronization

When several windows or processes change settings at once, conflicts are found through the revision, a version number that only grows.

Backends implementing `loadWithRevision` / `saveWithRevision` must check a monotonic revision. Each local mutation records three things: the explicit target keys, the desired values captured at that moment, and the last confirmed base. Mutations persist in order. Two consecutive `set` calls with the same value cannot be treated as already saved.

- **After a conflict.** Load and validate the remote snapshot first, then compare the keys this mutation touches. A retry under the new revision is allowed only if the remote value still equals the value before the mutation, or already equals the value to be saved.
- **Different keys do not interfere.** Mutations of different setting keys can be replayed safely. An object or an array counts as one setting key as a whole; its children are not merged implicitly. Deletion and absence take part in the comparison.
- **When the base advances.** Only a successful preceding local write advances the base of a queued mutation of the same key. An ordinary I/O failure is not a remote change, and the latest intent can still try to save against the confirmed base. A remote conflict on the same key does not let a later call with the same value succeed falsely.
- **Three sets of data are detached.** Confirmed snapshots, queued targets, and the publicly visible memory are independent. A caller may edit an object returned by `get()` and then call `set()`. Editing the object after the call does not change the queued target; another `set()` is needed.
- **Same-key conflict.** The current mutation is rejected with `SettingsRevisionConflictError`. `conflictingKeys` contains key names only, never values. Memory takes the latest confirmed values, while independent mutations still in the queue are kept. This kind of conflict does not permanently disable later writes.
- **Number of attempts.** Each mutation attempts at most three CAS writes (compare first, write only when equal). Under continued contention the save is still rejected; it does not fall back to unconditional replacement.
- **Failed reads.** A failed initial load stays read-only. When remote data fails schema validation, the write is not retried and the invalid snapshot is not published to subscribers.

**`refresh()`.** `SettingsStoreApi.refresh(): Promise<void>` reads non-secret settings in queue order and notifies the keys whose values actually changed.

- When a refresh and pending mutations happen together, the later mutations still check conflicts against their original base.
- Custom backends that declare no revision capability use serialized snapshot writes, and `refresh()` does not read them. This is a difference in backend capability; it does not mean old persistence formats are supported.

**When Web refreshes.**

- Ordinary settings: on storage events for `covel:settings`, on window focus, and when the page becomes visible again.
- The endpoint, price multiplier, and output-limit drafts keep the player's input when a remote update arrives, block automatic overwrite, and offer a "Reload saved value" action.
- API keys use the independent `refreshSecrets()` channel: they are read again on `covel:keys` storage events, on focus, and on restored visibility. Pending provider patches are kept. Secrets never enter ordinary-settings or revision broadcasts.

## Secret-channel boundaries

API keys are not stored with ordinary settings, and they are written differently.

**Incremental writes (patches).** `SettingsBackendAdapter.saveSecrets(patch)`, desktop `covel:keys:save`, and REST `/api/config/keys` all accept an incremental map from provider to `string | null`:

- Providers that are not mentioned stay unchanged; `null` deletes explicitly.
- Separate instances writing different providers do not overwrite each other.
- Writes to the same provider take effect in the order the backend receives them. Explicitly setting the old value again, or deleting a key that is not in the local cache, is still submitted.
- This channel provides no same-key CAS.
- `clearAll()` removes only the providers the current instance knows, not unknown providers another instance added later.

**How each backend keeps a write complete.**

- The localStorage backend must read the latest secrets, apply the patch, and write it back inside one Web Lock. Without Web Locks, saving secrets is refused; use an environment that supports them, on HTTPS or localhost.
- REST applies the patch on the server.
- Desktop IPC reads and merges the local file synchronously when the sidecar is unavailable.
- A custom adapter must implement the same atomic patch contract and does not receive complete secret snapshots.
- When localStorage reads the secrets map, it keeps provider names as the object's own data properties, including names such as `__proto__` that match the object prototype. Later patch saves do not silently lose those credentials through ordinary object assignment semantics.

**Where secrets never appear.** Secrets do not enter ordinary settings, revision broadcasts, or default exports.

**Which entries are secrets.** The `keys.*` namespace, and entries registered with `backend: "keys"` or `secret: true`, use the separate secrets channel. Declaring an ordinary backend does not change what `keys.*` means.

- If the ordinary `entries` selected for an import contain such an entry, the import is rejected explicitly before any write.
- Secrets must be in `bundle.keys`, with `includeSecrets: true` set explicitly.
- Ordinary serialization and exports always filter out known secret entries.

**When a secret is in the wrong place.**

- When load or refresh finds secret entries in an ordinary settings snapshot, it refuses to publish or replay that snapshot.
- During load, this check runs before the backups and writes of ordinary schema repair. On failure the store stays read-only and the original file is kept.
- When dynamic registration finds that an existing ordinary entry is in fact a secret, it also disables writes, removes the entry from ordinary exports, and cancels ordinary repairs that have not started.
- The store never migrates, deletes, or copies such misplaced secrets automatically.

## Effective models and capability sources

This section covers what the model settings pages show and when they save.

**Page behaviour.**

- When model-catalog metadata first arrives or is refreshed manually, only the capability data is queried again; the model settings cards are not rebuilt. Uncommitted input and the expanded state of generation parameters stay as they are. After the catalogue updates, capability displays and generation parameters use the refreshed lookup results.
- The model role list keeps the `default` role when it is configured, saved, or part of the default catalogue used when nothing is configured. When the role catalogue is empty, generation parameter inputs are disabled, and no empty role key is created.
- The model configuration entry on the world list opens the Providers & Models page directly. Narrow screens show the provider list first, then the full details after a selection, with a way back. In provider details, each model has only one connectivity-test entry.
- Current provider links and `keys.*` settings point to the Providers & Models page; other composite setting keys map to their own pages. The onboarding version number is internal state and is not shown as a regular setting.

**The role catalogue.** Model Roles and Generation share one live role catalogue. It combines four sources: server configuration, plugin runtime and `type: slot` declarations, user settings, and saved bindings and parameter overrides. Custom roles therefore remain editable on both pages. The role options in plugin settings also follow the current model configuration.

**The onboarding guide.** It closes only after its completion flag has persisted. While the save is pending, closing it again is disabled. When the save fails, the guide stays open, shows an error, and allows a retry. Resetting the guide on desktop likewise reports completion only after the reset has persisted.

**World preparation and the session sidebar.**

- World preparation shows all run stages of the selected plugins, and offers a separate text-model binding for each agent runtime.
- The provider roles of function runtimes are shown one by one for every `type: slot` setting. The precedence of the default is: the user's explicit override, the world's `pluginSettings`, the plugin's declaration. Clearing the user override restores the current world's default.
- The session's left sidebar reads the current session's plugin metadata and edits the session's model override for each runtime. A missing or incompatible binding is indicated explicitly.

**Where model limits come from.** Model Roles and Generation target the currently bound provider, model, and protocol. After the binding changes, the token limits of the previous server slot no longer limit the new model. Provider details also include the connection's protocol in capability lookups.

- **What may be taken as a model limit.** A lookup result with source `known` or `model-database` and `found: true`. A server target that is currently not overridden can keep its configured limits. An explicit user capability override takes precedence.
- **What may not be taken as a model limit.** `protocol-default` only estimates what the protocol supports; its numbers do not establish a model limit. The page then shows "Model limits unknown" and does not present the protocol's default context / output numbers as hard model limits.
- **When provenance is incomplete.** The capability in `/api/llm-config` does not carry complete source information. For an unknown model it cannot tell an explicit model configuration from a protocol fallback, so the UI does not use it to claim a known model limit.
- **Max output tokens.** Saved on blur or Enter, and only a positive integer is accepted. When the current limit is known, the value must also not exceed it. An empty value uses the provider default. When the limit is unknown, no HTML `max` is invented.

These are display rules. They change neither the model request protocol nor how the server resolves capabilities. The provider defaults, execution limits, and charges of a real request should still be checked against request traces and provider responses.

**Hot reload.** During a model-configuration hot reload, the request mappings of custom models stay isolated per registry. A mapping cleared by the reload is registered again on its next use and removed after its last request completes. A newly registered server preset of the same name takes precedence over an older request mapping.

## Debug refresh

The debug page reads session data at three moments: the first selection of a session, a manual refresh, and an automatic refresh. Each time it also updates the sidebar's phase, completed player turns, and setup runtimes.

- The data view shows the time of the last successful read. A failed read keeps the last successful result and marks it as possibly stale.
- A late response from another session does not replace the current data.
- An automatic refresh merges only the latest trace page, and keeps the older pages already loaded and the pagination cursor.

**Transport of the JSON file backend.** `createJsonFileBackend({ ipc })` requires an IPC transport supplied explicitly by the host; the backend does not probe `globalThis.covelIpc` itself.

- The Web app selects this adapter only when `getCovelIpc()` exists; a browser uses localStorage.
- This adapter reads and writes settings and secrets only through IPC; it has no REST transport.
- Settings writes carry an expected revision, secrets use a separate channel, and read failures propagate to the caller.

## Current provider configuration

`llm.providers` is the only store of model configuration.

- Startup and reads neither migrate from `llm.customPresets` nor fall back to it. The old navigation aliases, and the preset-write APIs that had no production caller, no longer exist.
- Affected development model configurations and credentials must be created again through the current provider UI. Old entries are not deleted automatically.

Which key belongs to what:

- Each connection uses `keys.<profile.id>`.
- Neither model configuration nor the flattened request configuration contains an API key.
- A connection does not borrow the key of another connection or of the same provider family.
- Server presets continue to use the key of the provider they belong to.
- The flattened `customPresets` structure in a request is still part of the current server routing contract.

## Model save and import lifetimes

**Uniqueness.** Connection IDs and model `ref` values must each be unique across all connections. Ordinary settings registration and model-file import share the same validation. A conflict rejects the whole batch; references are never merged or rewritten silently. The same model ID may have several configurations with different `ref` values.

**`setMany`: saving several keys together.** `SettingsStoreApi.setMany(entries)` validates all ordinary settings first, then saves them in one persistence operation.

- An invalid field, or a secret mixed in, rejects the batch before anything is written.
- The related keys take part in the revision conflict check together. A failure never commits only part of them.
- General settings import works the same way: it validates all selected ordinary keys before writing either channel. One invalid selected key rejects the whole batch; it is not skipped while other keys are written.
- Secrets still use the separate channel and are outside this all-or-nothing guarantee.

**`replaceEntries`: replacing the whole snapshot.** `SettingsStoreApi.replaceEntries(entries, expectedEntries)` saves a complete ordinary snapshot in one operation: it deletes the keys that are not passed in, and keeps passed-in ordinary keys that are not registered.

- `expectedEntries` is the snapshot of `export().entries` taken when the editor loaded.
- The call, and every CAS attempt, checks against the complete normalized snapshot. A remote addition, deletion, or modification of any key rejects with `SettingsRevisionConflictError`.
- All new values are validated before writing; secret entries are rejected; an I/O failure rolls back the whole replacement.
- Ordinary `setMany` still merges only the keys it touches, and `import` still merges only the selected keys.
- A custom backend without revision capability can only check the editor base within the same instance.

**`setProviderProfiles`: saving connections and models.** `setProviderProfiles(profiles, slotConfig?)` returns a Promise and saves connections / models together with slot bindings.

- Removing the last model removes only the local bindings that point to it, and keeps the empty connection and its key. An empty connection can still be edited, given models, exported, and imported.
- When a connection is removed explicitly, the ordinary settings save must succeed first; only then are the captured connection keys cleared. A later recreation of the connection, or a key change, in the same store prevents this stale cleanup.
- A failed cleanup is reported separately: `unclearedProviderIds` in the return value, a log without secret values, and a UI notice. Ordinary settings that were saved successfully do not pretend to be rolled back.
- The independent secrets channel does not yet provide cross-window CAS, or a transaction that spans both channels.

**Timing in the UI.**

- When a connection or a model is added, the dialog closes only after the save succeeds. Repeat submissions are disabled while saving. On failure the input is kept for a retry.
- The endpoint of an existing connection and a model name also update their confirmed values only after the save succeeds. Blur trims surrounding whitespace, so this save is not mistaken for another window's edit. A failed save keeps the draft editable.
- An import read has its own request ownership: choosing a new file invalidates the older read, and a result is no longer applied after the pane unmounts.
- Unrelated connection edits made during the read are merged. When the same connection conflicts, the current edit is kept and the player is asked to choose the file again.

**`modelRef` and `presetId` always stay apart.** Role bindings keep the `modelRef` / `presetId` distinction in settings, requests, and UI selection. The two may share a name.

- Switching between a local model and a server preset of the same name resets the model-specific reasoning overrides.
- The request field is `slotBindings`, and local definitions must accompany the request. Old string mappings, and duplicate or missing references, are rejected before the request runs.
- The storage format of ordinary settings is unchanged. No second read protocol is added for old clients.
- Connectivity tests and their cache also distinguish local models, server presets, and roles.

**Changing and resetting a role.** Changing or resetting a model role saves the binding and the cleanup of its related reasoning parameters in one `setMany`. Actions on the role cards are paused while saving. On success the confirmed selection is updated; on failure the previous configuration is kept and the save error is shown.

### Session advancement settings

“Automatic rounds” lives in session metadata as `autoAdvanceLimit`, rather than in SettingsStore user preferences. Read and change it through the [session API](./api.md#auto-advance); snapshots, forks and browser checkpoints retain it. A saved change applies to the next input; the running request keeps its original limit.
