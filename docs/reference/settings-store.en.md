# SettingsStore and model settings

> [中文版](./settings-store.md)

`@covel/settings` provides schema registration, in-memory values, subscriptions, and persistence. Web uses localStorage; desktop uses the configuration API and `settings.json`. API keys use a separate secrets channel.

## Schema normalization

Registered non-secret settings expose the schema's parsed result during hydration, dynamic registration, `set()`, `setMany()`, import, refresh, and rollback after a failed write. Nested `.default()` values and string trimming appear in `get()`, exports, and subscriber notifications; explicit writes persist the parsed result. Unregistered keys retain their original values.

Normalization during hydration or refresh does not independently trigger a save. Revision conflict checks still compare the original backend-confirmed snapshots, so filling defaults is not mistaken for a remote edit. Setting schemas must accept their own persisted output and normalize idempotently to support reloads, repeated registration, and synchronization.

Model-role bindings select exactly one target: `modelRef` for a local provider model or `presetId` for a server-configured preset. Ambiguous bindings containing both fields are rejected. Reading a binding never rewrites it.

Invalid custom themes in settings backups are skipped individually while valid themes continue to load. Provider imports accept only the current `{ version: 2, providers: [...] }` export envelope and sanitize each current profile independently. Unsupported files or nonempty imports with no usable profiles show an error and preserve the current configuration.

The Data import preview validates each entry against its currently registered schema. Incompatible entries and secrets misplaced in ordinary `entries` cannot be selected; unregistered ordinary keys remain importable. Backups containing only separate `keys` can also be applied. Import and reset report completion only after persistence succeeds; failed imports retain the preview and show an error.

## Multiple instances and synchronization

Backends implementing `loadWithRevision` / `saveWithRevision` must check a monotonic revision. Each local mutation records explicit target keys, captured desired values, and the last confirmed base, then persists in mutation order. Two consecutive `set` calls with the same value cannot assume the value was already saved.

- After a revision conflict, load and validate the remote snapshot before comparing the affected keys. Retry against the new revision only if each remote value still equals its original value or already equals the proposed value.
- Changes to different setting keys can be replayed. Objects and arrays are atomic keys; their children do not merge implicitly. Deletion and absence participate in comparison.
- Only a successful preceding local write advances an already queued same-key mutation's base. Ordinary I/O failures are not remote changes: a later intent may still save against the confirmed base. A remote same-key conflict cannot turn a repeated value into a false success.
- Confirmed snapshots, queued targets, and publicly visible memory are detached. Callers may edit an object returned by `get()` and then call `set()`. Further object mutations do not alter an already captured target and require another `set()` call.
- Same-key conflicts reject the mutation with `SettingsRevisionConflictError`. `conflictingKeys` contains key names, never values. Publish the latest confirmed values while retaining independent pending mutations. Ordinary conflicts do not permanently disable subsequent writes.
- Each mutation attempts at most three CAS writes. Continued contention rejects the save without falling back to unconditional replacement.
- Failed initial hydration remains read-only. Invalid remote values are neither published to subscribers nor used as the basis for another write attempt.

`SettingsStoreApi.refresh(): Promise<void>` queues a read of non-secret settings and notifies keys whose values actually changed. Pending writes still compare against their original base when a refresh runs before them. Legacy adapters without the revision protocol retain their serialized snapshot writes; `refresh()` does not read these adapters.

Web refreshes on storage events for `covel:settings`, window focus, and restored visibility. Endpoint, price multiplier, and output-limit drafts retain unfinished input when another window changes the saved value, block automatic overwrite, and offer an explicit reload action. API-key reads, writes, and deletions do not participate in this synchronization or merging.

## Secret-channel boundaries

The `keys.*` namespace and entries registered with `backend: "keys"` or `secret: true` use the separate secrets channel. A normal-backend declaration cannot override the reserved namespace. Selected ordinary import `entries` containing such a key are rejected before any writes. Secret imports must use `bundle.keys` with explicit `includeSecrets: true`. Ordinary serialization and exports always exclude known secret entries.

Hydration and refresh reject ordinary settings snapshots containing secret entries before publishing or replaying them. Failed hydration remains read-only and preserves the original file. Dynamically registering an existing ordinary entry as secret also disables writes and removes it from ordinary exports. The store never automatically migrates, deletes, or copies misplaced secrets.

## Effective models and capability sources

Initial model-catalog metadata and manual refreshes reload capability data without remounting model settings cards. Uncommitted input and expanded generation controls remain intact; capability displays and generation controls use the refreshed lookup results.

The world-list configuration entry opens Providers directly. Narrow screens show the provider list first, then full-width details with a return action. Each model has one connectivity-test entry in provider details.

Model Roles and Generation share a live role catalogue combining server configuration, plugin runtime and `type: slot` declarations, user settings, and saved bindings and parameter overrides. Custom roles remain editable in both panes, and plugin setting options follow current model configuration. Current provider links and `keys.*` settings resolve to Providers; other composite setting keys resolve to their owning pane. The internal onboarding version is no longer exposed as a general setting.

The onboarding guide waits for its completion flag to persist before dismissing. While a write is pending, duplicate dismissal is disabled; a failed save leaves the guide open with an error and allows retry. The desktop reset action likewise reports success only after the reset persists.

The `default` role remains visible when configured or saved, and in the unconfigured fallback catalogue. Generation inputs are disabled when the catalogue is empty; edits never create an empty role key.

World preparation shows all stages and separate text-model bindings for each agent runtime in a selected plugin. Function runtime provider roles expose every `type: slot` setting, with explicit user overrides taking precedence over world `pluginSettings`, then plugin defaults. Clearing an override restores the current world default. The session sidebar uses current session plugin metadata and edits model overrides per runtime, explicitly indicating missing or incompatible bindings.

Model Roles and Generation Parameters resolve the currently bound provider, model, and protocol. Changing a binding stops inheriting token limits from the previous server slot. Provider details include the connection protocol in capability lookups.

- Lookups with `found: true` and source `known` or `model-database` may supply model limits. The unchanged server target can retain configured limits; explicit user capability overrides take precedence.
- `protocol-default` only estimates transport support. Its numeric fallback values do not establish model limits. The UI reports unknown model limits instead of presenting protocol context/output defaults as hard limits.
- `/api/llm-config` capabilities do not contain complete provenance. For unknown models the UI cannot distinguish explicit configuration from protocol fallback, so it does not use those values to claim a known model limit.
- Max output tokens save on blur or Enter and must be a positive integer within any known current limit. An empty value uses the provider default. Unknown limits do not create an invented HTML `max`.

These presentation rules do not change request protocols or server capability resolution. Verify effective provider defaults, execution limits, and charges against request traces and provider responses.

Custom model overlays are isolated per registry during model-config reloads. A mapping cleared by reload is registered again on its next use and removed after its last request completes. Newly registered server presets take precedence over older same-name overlays.

## Debug refresh

Initial session selection, manual refresh, and automatic refresh load session data and update the sidebar phase, completed player turns, and setup runtimes. The data view shows its last successful read time; failures retain that snapshot and mark it potentially stale. Late responses from a previous session cannot replace current data. Automatic refresh merges the latest trace page while retaining older loaded pages and their pagination cursor.

## Current provider configuration

`llm.providers` is the sole model-profile store. Startup and reads do not migrate or fall back to `llm.customPresets`; old navigation aliases and unused preset-write APIs have been removed. Recreate affected development model configurations and credentials through the current provider UI. Existing obsolete entries are not automatically deleted.

Each connection uses `keys.<profile.id>`. Profiles and their flattened request overlays contain no API keys. A connection does not borrow another connection's or provider family's key, and server-managed secret markers are never sent as API keys. Server presets continue using their own provider keys. The flattened `customPresets` request field remains part of the current server routing contract.

## Model save and import lifetimes

Connection IDs and model `ref` values must each be unique across all profiles. Settings registration and provider-file import share this validation; conflicts reject the batch without silently merging or rewriting references. The same model ID may have multiple configurations with distinct refs.

`SettingsStoreApi.setMany(entries)` validates all ordinary settings before persisting one mutation. Invalid fields and secret keys reject the entire batch before writing. All dependent keys participate in revision conflict checks; persistence failure cannot commit only part of the batch. Secrets remain outside this atomicity guarantee.

`setProviderProfiles(profiles, slotConfig?)` returns a Promise and saves profiles with role bindings together. Removing the last model retains its empty connection and key, while removing bindings to that model. Empty connections remain editable and round-trip through provider export/import. Explicit connection removal waits for the ordinary settings save before clearing captured keys; later connection recreation or credential changes in the same store invalidate stale cleanup. Cleanup failures return `unclearedProviderIds` and produce diagnostics without secret values plus UI feedback, without pretending the committed settings rolled back. The independent secret channel does not yet provide cross-window CAS or a transaction spanning both channels.

Creation dialogs close only after persistence succeeds. Pending saves disable repeat submissions; failures retain input for retry. Import reads have request ownership: newer files supersede older reads, and unmounted panes discard results. Unrelated connection edits during reading are merged; edits to the same connection cause a conflict message and preserve current changes.

Inline endpoint and model-name edits publish confirmed values only after persistence succeeds. Blur normalizes surrounding whitespace so a successful local save is not mistaken for an external edit. Persistence failure retains the editable draft.

General settings import validates all selected ordinary keys before writing either channel. An invalid selected key rejects the batch instead of being skipped while dependent keys are saved. Ordinary settings and secrets still use separate persistence channels.

Bindings preserve the `modelRef` / `presetId` namespace in storage, requests and
UI selection. Equal names can identify different local and server models.
Changing namespace clears model-specific reasoning overrides. The request field
is `slotBindings`; local definitions must accompany references. Invalid routing
shapes, duplicate or missing references reject before execution. The stored
binding format is unchanged; no dual protocol supports old clients. Connectivity
requests and their cache also distinguish local models, server presets and roles.

Changing or resetting a model role saves its binding and dependent reasoning-parameter cleanup in one `setMany` operation. Role cards pause edits while saving and publish the confirmed selection after success; failure retains the previous configuration and reports the save error.
