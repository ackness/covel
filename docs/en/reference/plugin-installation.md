# Plugin catalogue and installation

This page explains how plugins get into Covel from GitHub or a ZIP file: the flow the player sees, which links can be pasted, the HTTP interfaces for installing and updating, and the limits. For step-by-step instructions for players, see [Install plugins and world packs](../start/packages.md). For authors, see [Publishing](../ship/publish.md). Read this page when you deploy, troubleshoot an installation problem, or connect to the installation interfaces.

The official catalogue is [covel-ai/covel-plugins](https://github.com/covel-ai/covel-plugins). Each plugin in the catalogue is one JSON entry, and the table in the README is generated from these entries. A third-party plugin's source stays in its author's own repository. Official extensions and examples can live in separate subdirectories of the catalogue repository.

## Categories and trust

- Built-in plugins ship with Covel. Official extensions and community plugins are installed when needed.
- Maintainer labels and feature categories are for display only. They take no part in permission decisions.
- The root manifest's `kind: core | plugin` says what role the plugin plays. `source: builtin | community` is decided by the directory where the plugin is found.
- An official plugin installed from outside is also `community` and is not enabled automatically. Discovery location and the instance trusted-source policy determine whether code approval needs a prompt, under the conditions below.

> [!WARNING]
> A plugin's server-side JavaScript does not run in a process sandbox. The permission checks of the public API cannot stop arbitrary third-party JavaScript from accessing the process's files, environment variables, and network. Being listed in the catalogue, passing a source digest comparison, and passing a static manifest check do not amount to a security audit.

## Trusted sources

No source is trusted by default, including the official repository. Add a GitHub owner or `owner/repo` in **Settings → Install & manage → Trusted sources**. The suggestion button only fills the official repository; press Add to save it. Entries are trimmed, lowercased, deduplicated and sorted: at most 100 entries, 100 characters each, and 39 characters per owner. Only GitHub names are accepted, not URLs.

`owner` matches all repositories of that owner; `owner/repo` matches only that repository. Matching is case-insensitive and compares complete names: `owner-evil` and `repo-evil` do not match. Non-GitHub HTTPS addresses, `.git` suffixes, trailing slashes, extra paths, queries and fragments do not match. Each plugin in a collection is judged by its own receipt's `source.repository`, including members pinned to another repository.

On the personal form (desktop and self-hosted Web), the instance owner saves `trust.sources` through the existing `PUT /api/config/server-settings`; the desktop shell's token is still required when configured. Hosted and browser-private forms use only the operator's comma-separated `COVEL_TRUSTED_SOURCES`, ignoring stored values. The environment overrides storage and locks the control; writes return `409 server_setting_fixed`, while writes on shared forms return `403 server_settings_operator_only`. One invalid entry invalidates the whole variable, treating it as unset and logging it at boot. Environment changes require a restart; personal stored changes apply immediately, with other server processes following the settings cache refresh.

### Capability snapshot

GitHub plugin previews always contain `capabilities` and `trustedSource`. Confirming an install from a trusted source adds optional `capabilities` to `.covel-install.json`, containing the capabilities shown in the preview:

- `serverCode`: whether code files or module references are present.
- `http`: the union of origins and methods declared by the root and every runtime; omitted methods mean `GET`.
- `hooks`: event and `enforce` pairs, defaulting to `normal`.
- `tools`: contributed tool names and runtime `tools.builtin`.
- `actions`, `services` (contract IDs), `wires`, `extensions` (`<point>/<id>`), and `forms`.
- `datasets`: namespaces and allowed write operations from `contributes.datasets`, separate from installation collections.

All lists are sorted and deduplicated. Current capabilities must be subsets of the snapshot, including HTTP methods and dataset operations. Changing a hook's phase counts as growth. Updating a trusted-source plugin carries the previous snapshot forward unchanged; no previous snapshot means none is written. Updates therefore cannot silently widen consent. Untrusted sources receive no new snapshot, and worlds receive none.

### File verification and automatic approval

Boot verifies the receipt and content digest of every registered community package with a path, without importing code. The server checks again before enable, execution preflight and lazy server-code activation, reusing digest results only while the stat signature of paths, sizes, modification times and related metadata is unchanged.

<!-- prettier-ignore -->
| `integrity` | Meaning and handling |
| --- | --- |
| `verified` | The digest matches the receipt; current policy and capabilities still need checking. |
| `modified` | Edited, added or deleted files, links or special files; show a warning and use normal approval. |
| `no-receipt` | No receipt, such as ZIP imports or hand-copied directories; no warning, normal approval. |
| `unreadable` | Damaged or unknown receipt fields, or another read failure; log, warn and use normal approval. |

A community package implicitly receives `covel:plugin-server-code` and its `runtime:*` grants only when its source is trusted **now**, integrity is `verified`, a snapshot exists, and current capabilities stay within it. Any missing condition, stale registration or read error uses the normal prompt. Removing a source immediately stops implicit grants; existing explicit session grants keep their normal meaning. The shared host's operator check still runs first and is never replaced by source policy.

After normal server-code approval is allowed, only a trusted, verified community package gets its snapshot atomically replaced with current capabilities. A write failure is logged without failing approval. This rewrite invalidates an earlier signed update preview: confirming returns `409 Installed package changed; check for updates again`, requiring another update check. For older receipts without a snapshot, the first normal approval satisfying these conditions records one. Receipts gain only an optional field; no stored data needs recreation.

Development reload re-registers the package and immediately invalidates verification. Local edits become `modified` and lose implicit approval until normal approval is given; that approval cannot update the snapshot while the digest still differs. Revoking session grants clears explicit grants only; instance source policy cannot be revoked per session.

Trusted sources preserve `builtin | community`, add no API or privilege, and do not select plugins automatically. ZIP imports, hand-copied directories, worlds, per-action RPC approvals and payload-bound one-time grants are outside this mechanism. A snapshot bounds declarations; it is not a sandbox or code audit and does not protect against a stolen GitHub account. Signed publication metadata, keys, rollback, expiry and revocation metadata are not implemented; the host's preview-token signature only confirms the content of this installation.

## User flow

Open **Settings → Install & manage**:

1. Browse the community catalogue, or paste a public GitHub repository link, or a `/tree/<ref>/<path>` link.
2. The link is resolved. The plugins and world packs in that directory are listed together. When the directory has a `covel-collection.yaml`, only the members named in the [collection](../ship/collections.md) manifest are listed, including packages pinned in other repositories.
3. Tick what you want to install, check the ID, version, source, commit, and code risk, and confirm once. The selected items are installed as one unit: plugins first, then worlds. If any one fails, everything installed in this batch so far is removed.
4. After installing a plugin, restart the backend once. Then enable the plugin in a session, and allow it to run through the approval flow. A world is usable right away.

The import entry in the desktop app's menu opens the same package management page. The server runs a static check on a ZIP and shows the result.

### Integrity checks in the preview

The preview also shows the result of the integrity checks. The checks only read the manifests. They do not run any plugin code.

| Case                                                                                                                                                     | Level   | Result                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------ |
| A contract that the root `requires` of a plugin, or a world's `pluginPolicy.requires`, needs has no provider among the "installed plus selected" plugins | Error   | The package cannot be installed while it is selected         |
| The host version is outside the range the package declares                                                                                               | Error   | The package cannot be installed while it is selected         |
| A plugin the world requests does not exist                                                                                                               | Warning | Can be installed                                             |
| A contract has several providers, and the world does not say which to use                                                                                | Warning | Can be installed                                             |
| While scanning a directory, a package cannot be read (invalid manifest, identity conflict, and so on)                                                    | Warning | This package is skipped, and the rest can still be installed |
| A member named in a collection manifest cannot be read                                                                                                   | Error   | The whole preview fails                                      |

### Languages

**A language is not a condition for installing.** A plugin has at least English. When there is no text in the player's language, the plugin is still installed and enabled as usual, and its labels fall back to English (or to the translation in the [translation catalogue](./i18n.md)).

- After a restart, the `languages` field of the plugin list shows which languages the plugin has text and instructions in.
- The session-prep screen marks plugins that have no text in the current interface language as "Not translated".
- Before publishing, an author runs `pnpm validate:plugin <dir>` to see the same summary.

### Where it is installed, and who can install

- Installation writes to the backend that is currently connected, which is not always the machine the browser runs on. A desktop instance writes to the local machine. A remote deployment writes to the server.
- Installing, previewing, querying install records, and uninstalling share the permission gate of the installation API. Demo and commercial deployments must use the operator token. A self-hosted instance in production needs the desktop token, or it must set `COVEL_INSTALL_API_ENABLED=1`.

### Restarts, reloads, and overwrites

- Importing a local ZIP is always available, and the interface requires the code risk to be confirmed first.
- GitHub install records and the directory on disk are independent of the registry loaded at startup. So a newly installed plugin, a plugin that failed to load, and a plugin waiting to be uninstalled can still be managed before a restart.
- Both installing and uninstalling need a restart.
- Uninstall first moves the whole plugin directory into `.covel-uninstall-*`, then deletes its files. If the rename fails, the complete original directory is retained and an error is returned. If cleanup after the rename fails, a warning is logged and the next startup retries it. A partial package cannot be loaded.
- A loaded community plugin supports [single-plugin hot reload](./plugin-extensions.md#single-plugin-hot-reload-during-development) in development mode.
- There is no background automatic update.
- A normal install does not overwrite a directory with the same ID. Updates go through a separate confirmation flow, see [Check and update](#check-and-update).

## GitHub input and release artifacts

### Which links can be pasted

- A repository root link, a tree link that points to a tag, commit, or branch, and a link to a plugin's subdirectory.
- A plain repository link is resolved through the GitHub API to the current commit of the default branch. A tree link resolves the ref it names.
- When a ref contains `/`, write that part of the URL as `%2F`, or use the commit SHA instead.
- After a repository is moved and a redirect is created, paste the new canonical address.

### More than one plugin in one repository

The framework searches the selected directory recursively for plugin packages (for example in `plugins/` and `examples/`). It ignores hidden directories and `node_modules`.

| Link pasted                                                   | What is listed                    |
| ------------------------------------------------------------- | --------------------------------- |
| `https://github.com/covel-ai/covel-plugins`                   | All installable packages          |
| `https://github.com/covel-ai/covel-plugins/tree/main/plugins` | Only the feature plugins          |
| Narrowed down to `plugins/mimo-tts`                           | Previews this one plugin directly |

- When the selected directory is itself a plugin package, it is treated as one complete package. Its `runtimes/` is not split apart for installation.
- At most 20 plugins can be previewed at once. When there are more, point to a narrower directory.

The settings page shows each plugin's ID and its path in the repository. Tick, review the risk, and confirm the installation.

- Each installation downloads the archive again for the same pinned commit, but it extracts only the directory of the selected package. It does not copy the tools of other plugins or of the repository root.
- After a preview expires, preview again.
- After all the needed plugins are installed, the backend can be restarted once for all of them.

### Network and source

- GitHub API resolution and archive downloads both go through the existing outbound network layer. They follow the direct, system proxy, HTTP(S), or SOCKS5 setting in real time. There is no second proxy setting.
- When an explicitly specified HTTP or SOCKS proxy fails, an error is raised. It does not quietly switch to a direct connection.
- The system proxy follows the routing order that the system resolves, including a DIRECT that the system explicitly returns.
- Only public GitHub source archives are downloaded. The user's GitHub credentials are not used.
- Release attachments are not downloaded automatically, and arbitrary URLs, private repositories, and GitHub Enterprise are not accepted. A built Release ZIP can be downloaded by hand and then imported.

### Package layout requirements

Installation uses the loader’s [manifest and runtime directory rules](./plugins.md#package-and-runtime-files). A runtime directory missing `RUNTIME.md` is reported with its path.

- A plugin package directory must have a root `PLUGIN.md`. A `package.json` is optional; when there is one, it must declare `"type": "module"`, otherwise the install returns 400. The installer does not read its `version`; the version comes only from `PLUGIN.md`.
- The root declaration uses `{ description, contributes, runtime? }`, plus `id`, `version` and other fields when needed.
- A package with several runtimes puts each execution declaration in `runtimes/<sub>/RUNTIME.md`. A sub-declaration uses `{ schedule, io, agent/function }`, and it does not repeat the plugin's identity.
- A root `runtime` and a subdirectory runtime cannot both be declared.
- Flat legacy fields, a missing root declaration, or a `PLUGIN.md` inside a subdirectory are all rejected at install time. The desktop app rejects them too when importing from a folder.
- When the plugin directory already has a package in this layout, startup records it only as that package's own load error (`status: error`). The other plugins load as usual.

For the fields, see the [plugin contract reference](./plugins.md).

In development mode, after adding a missing root `PLUGIN.md`, or changing a sub-runtime manifest to `RUNTIME.md`, you can revalidate with a single-plugin reload. This scan does not carry over the layout errors from startup. A failed community package that has not published any active capabilities yet restores only its static declarations. Running its entry, handler, and guard still requires normal authorization.

### What the installer does and does not do

- The plugin ID is the first valid value in this order, and it cannot be the ID of a built-in plugin (case does not matter; a clash returns 409):
  1. The `id` that `PLUGIN.md` writes. A written `id` that is not valid returns 400.
  2. The name of the folder that holds the package: the only top-level folder of a ZIP (ignoring `__MACOSX/`), the selected subfolder on GitHub, or the repository name when the package is at the repository root.
  3. The `name` in `package.json`, without its scope and one `plugin-` prefix (`@someone/plugin-notes` → `notes`).

  When none of the three gives a valid value, the install returns 400 and asks for an `id` in `PLUGIN.md`.

- A manifest and its language variants accept only plain YAML frontmatter, and they reject executable language markers.
- The installer does not run scripts, package managers, compilers, or plugin modules.
- Every plugin installation path (GitHub, ZIP, offline collection) and update requires self-contained runtime files: `dependencies`, `optionalDependencies`, and `peerDependencies` in `package.json` must be absent or empty. `devDependencies` are allowed. The host provides `@covel/plugin-handlers-utils` and `zod` to every plugin, so a plugin does not declare them as runtime dependencies; bundled plugins list them only under `devDependencies` too.
- Declared runtime dependencies return 400, naming the nonempty fields, before any package is written. Authors must bundle dependencies into the release files, then remove these declarations or leave them empty.
- A plugin that needs a build step should have its author provide built, self-contained files in a separate release directory.

Checks before installing: both kinds of input scope, inline runtimes and sub-runtimes, are checked for the local `accepts` files, and for whether the package's producer exists.

- A missing file, invalid JSON, a producer that does not exist in the package, or `scope: committed` written together with `select`, returns 400, and the package is not written.
- This check does not load the entry, guard, or handler.
- When an optional external contract has no provider yet, that alone does not cause the package to be rejected.

### Archive limits

The outer directory layer that a GitHub source archive carries is removed, and then the specified plugin directory is extracted. An ordinary uploaded ZIP still requires the package files to be at the top level of the ZIP.

| Limit                | Value   |
| -------------------- | ------- |
| Compressed file size | 20 MiB  |
| Number of entries    | 2000    |
| Uncompressed size    | 200 MiB |
| Expansion ratio      | 100     |

- These limits apply to the whole GitHub archive. For a large monorepo, use a trimmed release repository, or a local ZIP.
- All archives in a collection preview or batch installation share a 200 MiB extraction budget, including the manifest archive. The same repository and commit count once. Exceeding the budget returns 413 and stops reading later members. Offline collection ZIPs use the same budget.
- Symbolic links, paths that escape the directory, and duplicate file paths that differ only in letter case are all rejected.

## HTTP contract

The Zod schemas for requests and responses are in the `plugin-install` export of `@covel/shared`.

| Interface                                 | Request                        | Response                                                                        |
| ----------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| `POST /api/install/plugin/github/preview` | `{ url }`                      | `{ items: GithubPluginPreview[] }`                                              |
| `POST /api/install/plugin/github`         | `{ token, acceptRisk: true }`  | `{ ok: true, kind: "plugin", id, restartRequired: true }`, 201                  |
| `GET /api/install/plugins`                | None                           | `{ items: [{ id, version, source, pendingUpdate, integrity, trustedSource }] }` |
| `POST /api/install/plugin`                | multipart `file`               | ZIP installation response                                                       |
| `POST /api/install/github/preview`        | `{ url }`                      | `{ collection, items: GithubPackagePreview[], problems }`                       |
| `POST /api/install/github/batch`          | `{ tokens, acceptRisk: true }` | `{ ok: true, installed: [{ kind, id }], restartRequired }`, 201                 |
| `POST /api/install/collection`            | multipart `file`               | Same as the batch response, 201                                                 |

### Multi-package preview and batch install

- Each item from `/github/preview` carries `kind: "plugin" | "world"` in addition to the single-package preview fields. Its `token` is issued the same way as the single-package interface's, and it can be used for a single-package install or for a batch.
- `collection`: `{ id, name, version }` when the directory has a manifest, otherwise `null`.
- `problems` is `{ level: "error" | "warning", message, packageId? }[]`.
- A batch accepts 1–20 tokens. It first downloads and checks each one's digest and identity. Writing starts only when all of them pass and none of the targets already exists.
- If any target already exists, the request returns 409 without changes. A write failure rolls back packages installed by that request. World rollback uses the normal deletion lifecycle: the world lock, a deletion marker, and recoverable package files if record deletion fails.
- If a world acquired sessions during installation, rollback retains the world and its sessions. Packages whose deletion fails are also retained for retry. The error response’s `details` contains `rolledBack` and `retained`, each a `{ kind, id }[]` list. The `error` message also names retained packages so partial rollback is visible.
- `/collection` accepts a ZIP produced by `pnpm pack:collection` (the manifest is at the top level, and it contains all the members). It has no preview step, so integrity check errors are returned directly as 400.

### Host version range

A plugin's root manifest can declare a `covel` version range (for example `">=0.0.45 <0.1.0"`).

- When the host version is outside the range, previewing, installing, updating, and ZIP import all reject the package, and they give both version numbers.
- A package already on disk is checked against the same range. When the server starts or reloads, and the host version is outside the range (a package copied in by hand, or the host version changed after installation), the package is recorded as a load failure with the same message, and its code is not run. It recovers once it is replaced with a compatible version.
- For the syntax, see the [collections guide](../ship/collections.md#version-ranges).

### What the preview contains

The preview includes the ID, package version (the `version` of `PLUGIN.md`), description, author name (`author`, `null` when the manifest does not declare one), a hint about whether code is present, the source, the signed token, and `expiresAt`.

- The source is `{ repository, commit, path, digest, tracking }`; `capabilities` always lists requested capabilities, and `trustedSource` marks whether the source was trusted at preview time.
- `tracking` is `{ kind: "default-branch" }`, `{ kind: "branch", ref }`, or `{ kind: "pinned", ref }`. A repository root link tracks the default branch. A tree link first tries to resolve to an explicit branch. Anything else, such as a tag or a commit, stays locked.
- `description` is `I18nText`, retaining description translations for `PLUGIN.md` from `locales/<locale>.yaml` (`.yml` also works). Clients call `resolveI18nText` with the UI language.
- `hasServerCode` uses the loader’s module-path enumeration: entry (when not written, an existing `server/index.js`), function handler (when not written, an existing `handler.js` next to `RUNTIME.md`), guard, and world projection handler. It also scans code files, including `.mts` and `.cts`. ZIP installation returns the same field. This is a conservative hint, not a complete code audit; test or build sources can also trigger it.
- The compatible host version is declared by the author in the manifest's `covel` field, in the directory, and in the README. The installer checks only the manifest format and this range. It does not judge whether the runtime is really compatible.

### Signing and download

- A preview does not write to the plugin directory.
- The signature covers the source repository, the commit, the subdirectory, the file digests, and the preview information. It is valid for 15 minutes, and it expires when the process restarts.
- An installation uses only what the signature contains. It downloads the pinned commit again, and then compares the digest of the file contents. The digest is sorted by path and includes file names and lengths, so it does not depend on GitHub's ZIP staying byte-for-byte stable.
- If the digest changed or the signature expired, it returns 409, and the package must be previewed again and confirmed.
- A download accesses only the fixed GitHub API and codeload addresses. It refuses redirects, does not forward operator or browser credentials, limits the number of bytes read in a stream, and times out a single request after 30 seconds.

### Writing to disk and install records

- Only after the installation is confirmed is the package written to disk, through a temporary directory followed by a rename. A `.covel-install.json` is attached, recording the source, version, and installation time.
- This file records the source and optional capability snapshot; skipping prompts also requires current policy and file verification. A plugin package cannot bring this file with it, including variations in filename case.
- A plugin installed from a ZIP or by hand has no source record, and the interface returns `source: null`.
- Cancelling a preview does not write to the plugin directory. After an installation is confirmed, there is no "cancel submission" action.

At startup, before applying updates or discovering plugins, `.covel-install-*` and `.covel-uninstall-*` directories in the user plugins directory are removed, along with unfinished `.covel-install-*` directories under `.covel-updates/`. Updates queued by plugin ID and transaction backups are retained for update recovery. Cleanup does not follow symbolic links. If files remain locked, it logs a warning and retries at the next startup.

### Error codes

| Status code | Case                                     |
| ----------- | ---------------------------------------- |
| 400         | Invalid input or manifest                |
| 401 / 403   | No permission                            |
| 404         | Repository or ref does not exist         |
| 409         | Expired, conflicting, or content changed |
| 413         | Over the size limit                      |
| 429         | GitHub rate limit                        |
| 502         | Upstream response failed                 |

Network transport errors use the same response format as installation errors.

## Check and update

Every installed plugin in the settings has "Check for updates."

- A check is triggered by the player. There is no timed polling, and nothing is downloaded or replaced automatically.
- A plugin installed from a branch tracks the saved branch. A plugin installed from a repository root tracks the current default branch. A plugin installed from a tag or commit stays locked.
- You can expand "Choose another version" and paste a version link for the same repository and the same plugin directory. An update cannot be used to switch the source or the plugin's identity.
- A tag that contains `/` needs `%2F` encoding, for example `/tree/mimo-tts%2Fv0.0.40/plugins/mimo-tts`.
- Published versions are not listed automatically.

| Interface                                        | Request                       | Response                                                                               |
| ------------------------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------- |
| `POST /api/install/plugin/github/update/preview` | `{ id, url? }`                | `{ status: "current" }`, `{ status: "pinned" }`, or `{ status: "available", preview }` |
| `POST /api/install/plugin/github/update`         | `{ token, acceptRisk: true }` | `{ ok: true, kind: "plugin", id, restartRequired: true }`, 201                         |
| `DELETE /api/install/plugin/github/update/:id`   | None                          | `{ ok: true }`, cancels an update that has not been applied yet                        |

### Update preview

The update preview uses the same fields as the installation preview, and it adds `previous: { version, source }` and a file list `changes: { added, modified, removed }`.

- The interface shows the current version and the target version, the exact commit, the file changes inside the package, and a link to the commit comparison of the whole repository on GitHub.
- An update is suggested only when the content digest of the selected plugin directory has changed. Commits to other plugins in the same repository, or to the root README, do not cause a false alarm.
- When the version number has not gone up but the content has changed, it is still suggested. The user checks it and confirms.

### Confirm the update

- The signature distinguishes "install" from "update." It binds the current install record, the target content, and a 15-minute validity period.
- When confirming, the pinned commit is downloaded again. The content digest, the identity, the manifest, and the built-in ID restrictions are checked again. Then the local install record and the file contents are checked once more.
- Downloading and checking follow the existing proxy, the public GitHub address constraints, and the archive limits.
- Installing, staging, cancelling, and uninstalling the same plugin are mutually exclusive. Submitting an update that is already waiting to be installed again returns 409.

### Stage it, and replace it on the next start

After confirmation, the new package and the replacement plan are written atomically into `.covel-updates/<id>/` in the user plugin directory. Files in use are not overwritten.

- The `pendingUpdate` from `GET /api/install/plugins` is `{ version, source, error }`, or `null`. While it is set, the current `version` is still the version of the old package.
- A staged update can be cancelled. Uninstalling a plugin also cleans up its staged update.
- Packages installed from a ZIP or by hand, and packages without a valid source record, get no automatic check.

On the next backend start, before community plugins are discovered and their code is loaded:

1. The old package, the staged package, and the digests are checked again.
2. The old package is moved into a transactional backup, and then the new package is put in place.
3. If placing it fails, the old package is restored, and the error is shown in the installed list. After it completes normally, the transactional backup is deleted.

If startup is interrupted, the next start uses the backup and the target content to restore or complete this replacement. When the state cannot be determined, startup stops and the files are kept for manual recovery. This flow only handles failures in replacing files. It does not automatically roll back logic errors or data changes that happen after the plugin runs.

### What an update does not touch

- Settings, sessions, plugin data, and MediaStore do not belong to the plugin package. An update does not delete or change this persistent data. Whether the data format is still compatible is the plugin author's responsibility.
- Adding, deleting, or changing any local file in the package directory, and symbolic links, all block the replacement. Back up and deal with these changes first.
- The old process keeps using the old files. In the new process, the community execution grants are established again, so confirming an update does not inherit the old process's execution grants.
- One plugin's install directory should be managed by only one backend process.

### Symbolic links

The discovery stage follows symbolic links inside the plugin directory that point to directories. This lets a developer link local plugin source into the user plugin directory. Installing and updating, however, reject symbolic links. A link's target can be outside the plugin directory, so do not let anyone other than the operator write into the user plugin directory.

> [!NOTE]
> A development-time install record must carry a `tracking` field. An old record without this field is not inferred as an update source, and it is not migrated. Back up local source changes first, then uninstall, and reinstall from an explicit source. Session data stored separately is not deleted by uninstalling.

## Maintenance scope

The following plugins are in the [official community repository](https://github.com/covel-ai/covel-plugins), not built into the main repository: Jev Recommendation Demo, DashScope / OpenAI image generation, and MiMo TTS. Their plugin IDs, runtime IDs, and settings keys are the same as when they were built in.

When upgrading from the built-in versions of these plugins:

- Existing sessions need the matching plugins installed from the catalogue first, then the backend restarted, and the server code authorized again. The original built-in trust is not inherited automatically.
- Existing saves, plugin data, model settings, and media are not deleted on purpose, and no database schema migration is needed.

Not provided at the moment:

- A web marketplace.
- Automatic background upgrades.
- Isolated execution of plugins.
- Raising permissions based on catalogue tags.
- Updating or uninstalling a collection as a whole. A collection takes effect only at installation time. Installed members are updated and uninstalled independently.

## Session selection and execution authorization

Selecting a plugin and allowing its code to run are two different things.

- `SessionRecord.activePlugins` stores the player's selection. It does not mean that the community code already has execution authorization.
- When a session is created, all the resolved selections are kept. Code execution and lifecycle hooks during creation use only the authorized set.
- `active` in `GET /api/sessions/:id/plugins` means the authorization that is currently in effect. `approvalRequired: true` means the plugin is selected, but this session has no authorization in the current process.
- A plugin that is not selected does not appear as waiting for authorization.

### Authorization prompt on the web

After a session is created or restored, the web sends **one** prompt that asks for authorization of these plugins.

- The prompt lists each waiting plugin's name, ID, version, and summary. All are ticked by default, and the player can untick some of them before confirming.
- The prompt comes before the approval requests. After confirmation, a request is started one at a time for each ticked plugin, and each is approved and enabled. Each plugin still has its own approval request and its own authorization.
- No request is produced for an unticked plugin, or when the player chooses "Not now."
- The reason for handling them one at a time: enabling one plugin makes the server clear the pending approval requests of other paused plugins in the same session.
- When enabling a single plugin on its own from the plugin list, a single-item confirmation is used.
- The prompt is shown automatically only once per visit and per plugin.
- After a refusal, the paused prompt is kept, and you can retry or disable on purpose. Leaving the page does not approve anything for other sessions.
- Approval follows the enable → approval → enable flow.

Authorization is not kept across a backend restart. In particular, an old authorization must not be carried over after the code has been updated. Built-in plugins load automatically and do not need authorization.

## In-app validation

Players without a source checkout or pnpm can open **Settings → Install & manage** and click **Validate** on an installed package, or select plugin or world and drop a ZIP. ZIP validation does not install the package. The API also accepts directory paths within allowed roots; the UI has no directory picker yet.

ZIP validation uses the [installation rules for plugin IDs](#what-the-installer-does-and-does-not-do), preserving identities derived from the package directory or `package.json.name` instead of using the temporary directory name. When no valid ID can be resolved, the report omits `id` and returns an `identity-invalid` error with `ok: false`. The static validator reports manifest parsing errors separately.

Validation reads manifests and referenced files, checking fields, files, languages and static declarations. It never imports or executes package code, and changes no world or save. It shares the CLI validation core; the plugin CLI displays the first failure, while the app continues collecting problems that can be checked independently.

Reports contain `kind`, `id` when available, `ok`, `counts.errors`, `counts.warnings` and `issues`. Each issue has `severity`, `code`, `message`, and, when known, a package-relative `file`, manifest field path or JSON pointer `field`, and repair `hint`. The summary may include version and languages. Messages are limited to 2000 characters; the first 200 issues are retained, with an additional `issues-truncated` warning and omitted count when necessary. Headings and known codes use the UI language; other messages stay in English. Reports can be copied as plain text.

Access uses the same `host.files` rules as installation: hosted instances require the operator Bearer token; personal instances retain the install API’s desktop token or explicit enablement rules. Paths must resolve to directories within the corresponding plugin or world roots, and symlinked package roots are rejected. Reports make package paths relative and replace other host paths with `<path>`; CLI-only raw text is never returned. See [API](./api.md#in-app-validation) for requests.
