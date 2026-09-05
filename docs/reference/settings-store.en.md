# SettingsStore and model settings

> [中文版](./settings-store.md)

`@covel/settings` provides schema registration, in-memory values, subscriptions, and persistence. Web uses localStorage; desktop uses the configuration API and `settings.json`. API keys use a separate secrets channel.

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

The world-list configuration entry opens Providers directly. Narrow screens show the provider list first, then full-width details with a return action. Each model has one connectivity-test entry in provider details.

Model Roles and Generation Parameters resolve the currently bound provider, model, and protocol. Changing a binding stops inheriting token limits from the previous server slot. Provider details include the connection protocol in capability lookups.

- Lookups with `found: true` and source `known` or `model-database` may supply model limits. The unchanged server target can retain configured limits; explicit user capability overrides take precedence.
- `protocol-default` only estimates transport support. Its numeric fallback values do not establish model limits. The UI reports unknown model limits instead of presenting protocol context/output defaults as hard limits.
- `/api/llm-config` capabilities do not contain complete provenance. For unknown models the UI cannot distinguish explicit configuration from protocol fallback, so it does not use those values to claim a known model limit.
- Max output tokens save on blur or Enter and must be a positive integer within any known current limit. An empty value uses the provider default. Unknown limits do not create an invented HTML `max`.

These presentation rules do not change request protocols or server capability resolution. Verify effective provider defaults, execution limits, and charges against request traces and provider responses.

## Debug refresh

Initial session selection, manual refresh, and automatic refresh load session data and update the sidebar phase, completed player turns, and setup runtimes. The data view shows its last successful read time; failures retain that snapshot and mark it potentially stale. Late responses from a previous session cannot replace current data. Automatic refresh merges the latest trace page while retaining older loaded pages and their pagination cursor.
