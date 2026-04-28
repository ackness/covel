# Unified Settings Store — Design Spec

**Status:** Draft
**Date:** 2026-04-21
**Scope:** Frontend user preferences + plugin-declared user settings
**Out of scope:** Game data (plugin_data, state snapshots), session-scoped bindings, session records, per-plugin manifest declarations.

---

## 1. Problem

Settings are currently spread across 5 files and 4 storage media with no unified API:

| Storage | Contents |
|---|---|
| `localStorage` (12+ keys) | locale, appearance, slot config, custom presets, param overrides, capability overrides, provider keys (fallback), runtime priority, runtime bindings (per-session), onboarded flag, migration/storage-mode flags |
| Electron IPC → `~/.covel/keys.env` | API keys (desktop) |
| REST `/api/config/keys` → `~/.covel/keys.env` | API keys (Tauri / self-host) |
| `~/.covel/llm.toml` | Slot / provider definitions |
| IndexedDB `covel-app` | Game data (not settings — out of scope) |

Consequences:

- **Call sites** import from 5 different files (`services/api.ts`, `lib/appearance.ts`, `i18n/locale-detector.ts`, `services/data-service.ts`, `components/onboarding-wizard.tsx`). Adding a new setting = touching registry + setter + getter + consumer + UI in multiple places.
- **Save model is inconsistent**: locale / appearance save immediately; slot config / keys / params need explicit "Save" button; runtime bindings auto-save. Users cannot predict behavior.
- **UI style is inconsistent**: Locale and Appearance float above the Tabs; Desktop tab has no Save button; form widgets mix raw `<input>` / `<select>` with shadcn components.
- **Data location is opaque**: when the user changes `data_root`, settings stay in browser `localStorage` instead of moving with `~/.covel/`.
- **No import/export**: there is no way to back up preferences or migrate between machines.
- **Plugins cannot declare user settings**: future plugins need a mechanism to expose tunable preferences to the user without bespoke UI work.

## 2. Goals

1. **One API** for reading / writing / subscribing to any user preference.
2. **Tier-aware backend**: desktop → `<covelHome>/settings.json`; web → `localStorage`. Secrets stay in `keys.env` (mode 600) but expose the same API surface.
3. **Auto-save everything**: no explicit Save button. Each `set()` persists + notifies subscribers.
4. **Plugin-declared user settings**: PLUGIN.md frontmatter can declare `userSettings`, auto-rendered in Settings UI and readable from plugin runtime context.
5. **Unified Settings UI**: left navigation tree + right content pane, search bar, deep-linking.
6. **Import / export** of the entire settings bundle (secrets opt-in).
7. **Data follows `dataRoot`**: changing data location moves settings.json with it.

## 3. Non-goals

- Cross-device cloud sync / user accounts / auth — deferred until commercial tier.
- Migrating existing users' data — project is early, single developer user, old keys will be deleted on first boot of new code.
- Versioned schema migrations beyond a `schemaVersion` field (future work).
- Moving game data (plugin_data, state snapshots, etc.) into settings.json — these remain in DataStore / IDB.

## 4. File Layout

Four files coexist under `<covelHome>/` (desktop) or browser-equivalent:

| File | Content | Format | Access |
|---|---|---|---|
| `keys.env` | API keys | KEY=value lines, mode 600 | IPC / REST (desktop); `localStorage` fallback (web) |
| `llm.toml` | Slot / provider definitions | TOML | Hand-edit friendly; server-loaded |
| `config.toml` | Desktop shell config (ports, paths) | TOML | Desktop shell |
| **`settings.json`** | **Front-end user preferences (NEW)** | **JSON** | **Via unified SettingsStore** |

### `settings.json` shape

Flat key → value JSON. Dot-notation key names group related settings.

```json
{
  "schemaVersion": 1,
  "savedAt": "2026-04-21T17:00:00Z",
  "entries": {
    "ui.locale": "zh-CN",
    "ui.appearance": "paper",
    "ui.onboardedVersion": 2,

    "llm.slotConfig": { "default": { "presetId": "preset_openai" } },
    "llm.customPresets": [],
    "llm.paramOverrides": { "default": { "temperature": 0.8 } },
    "llm.capabilityOverrides": {},

    "plugin.narrator.verbosity": "balanced",
    "plugin.image.defaultStyle": "anime",
    "plugin.narrator.runtime.narrator.priority": 520
  }
}
```

Only `entries` is authoritative data — `schemaVersion` / `savedAt` are metadata.

**Web storage**: one `localStorage` key `covel:settings` holds the same JSON blob. Single key means import/export and migration are trivial.

## 5. Classification

Every currently-stored key must be placed in one of these buckets:

| Bucket | Backend | Exported by default? |
|---|---|---|
| User preference | `settings.json` / `localStorage` | Yes |
| Secret (API keys) | `keys.env` | No (opt-in) |
| Session state | `SessionRecord` / `plugin_data` | Never (per-session) |
| Internal migration flag | `localStorage` outside settings | Never |
| Deprecated | Deleted on first boot | N/A |

### 5.1 Current keys → new home

| Current key | New home | Notes |
|---|---|---|
| `covel:locale` | `settings.ui.locale` | |
| `covel:appearance` | `settings.ui.appearance` | |
| `covel:onboardedVersion` | `settings.ui.onboardedVersion` | |
| `covel:onboarded` | Delete | Legacy |
| `covel:slotConfig` | `settings.llm.slotConfig` | |
| `covel:customPresets` | `settings.llm.customPresets` | |
| `covel:paramOverrides` | `settings.llm.paramOverrides` | |
| `covel:capabilityOverrides` | `settings.llm.capabilityOverrides` | |
| `covel:runtimePriority` | `settings.plugin.<pluginId>.runtime.<runtimeId>.priority` | Flattens into plugin namespace |
| `covel:providerKeys` | `keys.env` (already has primary home); API surfaces as `settings.keys.<provider>` | Wrapped through SettingsStore but stored in `keys.env` |
| `covel:runtimeBindings:<sessionId>` | `SessionRecord.runtimeModelOverrides` (field already exists server-side) | Delete localStorage key; UI reads from session state |
| _(no legacy)_ | `settings.llm.prepRuntimeBindings` | New — pre-session runtime-to-slot map keyed by worldId. Transient: copied to `SessionRecord.runtimeModelOverrides` on session create, then cleared. |
| `covel:storageMode` | Delete | Deprecated (always "remote") |
| `covel:idbMigrated` | Keep (unrelated IDB migration flag) | Game-data migration, not settings |

### 5.2 Plugin-declared user settings

New PLUGIN.md frontmatter field:

```yaml
---
name: image
version: 1.0.0
# ...
userSettings:
  - key: defaultStyle
    type: select
    default: anime
    label:
      zh-CN: 默认图像风格
      en-US: Default image style
    description:
      zh-CN: 生成图像时的默认艺术风格
      en-US: Default art style for generated images
    options:
      - value: anime
        label: { zh-CN: 动漫, en-US: Anime }
      - value: realistic
        label: { zh-CN: 写实, en-US: Realistic }
  - key: maxConcurrent
    type: number
    default: 2
    min: 1
    max: 10
    label: { zh-CN: 最大并发生成数, en-US: Max concurrent generations }
---
```

On plugin load, the framework:
1. Reads `userSettings` array.
2. For each entry, registers `plugin.<pluginId>.<key>` in the settings registry with the declared schema, default, and UI metadata.
3. Stores values under that key in `settings.json`.

Plugin runtimes read their own settings through the injected runtime context:

```ts
// Inside a plugin runtime
const style = ctx.settings.get("defaultStyle"); // scoped to this plugin; no pluginId needed
await ctx.settings.set("defaultStyle", "realistic");
ctx.settings.subscribe("defaultStyle", (v) => { /* react */ });
```

The context wrapper automatically prefixes `plugin.<pluginId>.` — plugins never see the global namespace of other plugins' settings.

## 6. API

### 6.1 Core store

```ts
// packages/shared/src/settings/types.ts

export type SettingKey = string; // e.g. "ui.locale", "plugin.image.defaultStyle"

export interface SettingEntry<T = unknown> {
  key: SettingKey;
  schema: ZodSchema<T>;          // validates on set + on boot
  default: T;

  // Grouping for UI
  group: "general" | "llm" | "plugin" | "desktop" | "data";
  pluginId?: string;             // required when group === "plugin"

  label: I18nText;               // string | Record<string, string>
  description?: I18nText;

  // UI hint (auto-inferred from schema; overrideable)
  widget?: "text" | "secret" | "select" | "slider" | "toggle" | "number" | "textarea" | "json" | "custom";
  options?: Array<{ value: string; label: I18nText }>;
  min?: number; max?: number; step?: number;

  // Backend routing — default "settings"
  backend?: "settings" | "keys";

  // Excluded from default export if true (auto-true when backend === "keys")
  secret?: boolean;

  // Conditional visibility (right-pane only shows when true)
  visibleWhen?: (store: SettingsStore) => boolean;
}

export interface SettingsStore {
  // Reads
  get<T>(key: SettingKey): T;                        // always returns registered default if unset
  has(key: SettingKey): boolean;                     // has explicit value vs default
  list(group?: string): SettingEntry[];              // filter by group for UI
  export(opts?: { includeSecrets?: boolean }): SettingsExportBundle;

  // Writes
  set<T>(key: SettingKey, value: T): Promise<void>;  // async because desktop writes go through IPC
  clear(key: SettingKey): Promise<void>;             // reset to default
  clearAll(group?: string): Promise<void>;
  import(bundle: SettingsExportBundle, opts: { keys: SettingKey[]; includeSecrets?: boolean }): Promise<void>;

  // Subscribe
  subscribe<T>(key: SettingKey, handler: (value: T) => void): () => void;
  subscribeAll(handler: SettingsListener): () => void;

  // Registry (called at boot / plugin load)
  register<T>(entry: SettingEntry<T>): void;
  unregister(key: SettingKey): void;                  // on plugin unload

  // Secrets helpers — raw access for code that ships API keys as headers
  listSecretProviders(): readonly string[];
  snapshotSecrets(): Record<string, string>;
}

export interface SettingsExportBundle {
  schemaVersion: 1;
  exportedAt: string;
  entries: Record<SettingKey, unknown>;
  // `keys` section only present when exportWithSecrets was true at export time
  keys?: Record<string, string>;
}
```

### 6.2 Backend adapters

Two concrete adapters behind one interface:

```ts
interface SettingsBackend {
  load(): Promise<Record<SettingKey, unknown>>;
  save(entries: Record<SettingKey, unknown>): Promise<void>;
  // Secrets have a dedicated channel because file path / encryption differ
  loadSecrets(): Promise<Record<string, string>>;
  saveSecrets(keys: Record<string, string>): Promise<void>;
}

class JsonFileBackend implements SettingsBackend {
  // Desktop: writes <covelHome>/settings.json via IPC (Electron) or REST (Tauri / self-host)
  // Atomic write: tmpfile + rename
  // Secrets delegate to keys.env (mode 600 preserved)
}

class LocalStorageBackend implements SettingsBackend {
  // Web: single key "covel:settings" + "covel:keys" (legacy fallback)
  // Synchronous underlying API, but wrapped in Promise.resolve for uniform interface
}
```

Selection at boot: `isDesktopApp()` → `JsonFileBackend`, else `LocalStorageBackend`.

### 6.3 Registry initialization order

```
app.boot()
  ├─ adapterFactory()                  # pick JsonFile or LocalStorage
  ├─ store = new SettingsStore(adapter)
  ├─ registerCoreSettings(store)        # ui.locale, ui.appearance, etc.
  ├─ registerLlmSettings(store)         # llm.slotConfig, llm.customPresets, etc.
  ├─ await store.load()                 # read file/localStorage → in-memory cache
  ├─ loadPlugins()                      # for each plugin manifest:
  │    └─ registerPluginUserSettings(store, plugin)   # register plugin.<id>.*
  └─ firstRender()                      # Settings UI consumes `store.list()`
```

Once `store.load()` resolves, `get()` is synchronous — `set()` remains async (awaits the write).

## 7. UI

### 7.1 Layout

Left nav + right content, inside the existing Dialog (retains current "overlay over main surface" pattern). Minimum width 800px; below that, collapses to tab-only nav like current dialog.

```
┌─────────────────────┬─────────────────────────────────────┐
│ [Search settings…]  │  (group / key title)                │
├─────────────────────┤  (description)                      │
│ ▸ General           │                                     │
│   Language          │  [widget]                           │
│   Appearance        │                                     │
│ ▾ LLM               │                                     │
│   Slots             │                                     │
│   Keys              │                                     │
│   Presets           │                                     │
│   Advanced          │                                     │
│ ▾ Plugins           │                                     │
│   narrator     │                                     │
│   image        │                                     │
│   …                 │                                     │
│ Desktop             │                                     │
│ Data                │                                     │
└─────────────────────┴─────────────────────────────────────┘
[Import] [Export] [Reset group]                   [Close]
```

### 7.2 Search

Top-of-nav input filters the tree:
- Matches on `entry.key`, `entry.label`, `entry.description`
- Matches on group label
- Highlights matched nodes; collapses unmatched branches

### 7.3 Deep linking

```ts
openSettings("llm.slots.default");       // expands LLM > Slots, scrolls to "default" entry
openSettings("plugin.image");       // expands Plugins > image group
```

Exported as:

```ts
function openSettingsTo(key: SettingKey): void;
```

Can be called from onboarding, error toasts, context menus.

### 7.4 Widget rendering

| Widget | Inferred from | Controls |
|---|---|---|
| `text` | `z.string()` | `<input type="text">` |
| `secret` | `backend === "keys"` or `secret: true` | `<input type="password">` + visibility toggle + monospace font |
| `textarea` | `z.string()` with long default or `widget: "textarea"` | `<textarea>` |
| `number` | `z.number()` | `<input type="number">` |
| `slider` | `z.number()` with min/max | Range + number input side-by-side |
| `toggle` | `z.boolean()` | Switch |
| `select` | `z.enum(...)` | Native `<select>` |
| `json` | `z.record(...)` or `z.object(...)` | Monaco-style mini editor |
| `custom` | Caller registers a React component | — |

Widget styling rules (applies across all tabs):
- All inputs use shadcn form primitives. No raw `<input>` / `<select>` with ad-hoc Tailwind.
- Label: `text-xs uppercase tracking-widest text-muted-foreground` (matches current dominant style).
- Field border: `border border-border`, focus: `ring-1 ring-primary`. No `rounded`.
- Spacing: `space-y-3` between field rows, `space-y-1.5` within a field.
- Secrets: always `type="password"` + visibility toggle, fixed monospace font.

### 7.5 Special groups

- **Desktop**: only rendered when `isDesktopApp()`. Contents unchanged from current `DesktopSettingsTab`, but wrapped in the same widget primitives for visual consistency.
- **Plugins**: auto-populated from registry. Each plugin with ≥1 `plugin.<id>.*` entry becomes a child node. Node label = plugin display name. A plugin with zero `userSettings` does not appear.
- **Data**: Import / Export bundle, Reset All, "Open settings.json" (desktop only), data root location (desktop only — moved from current Desktop tab).

## 8. Import / Export

### 8.1 Export

- Button in Data group: `[Export settings]`.
- Default: bundle contains every entry with `backend === "settings"` (excludes `keys.env` content).
- Checkbox: `[ ] Include API keys in export`. When checked, adds `keys` section to bundle. User warned the file is now sensitive.
- File name: `covel-settings-<iso-date>.json`.
- Bundle schema matches `SettingsExportBundle` above.

### 8.2 Import

- Button in Data group: `[Import settings]`.
- Opens file picker, reads JSON, parses via Zod.
- Shows diff preview:
  ```
  Importing from covel-settings-2026-04-15.json

  [✓] ui.locale         en-US → zh-CN        (change)
  [✓] ui.appearance     modern → paper       (change)
  [✓] llm.slotConfig    (new 2 entries)      (new)
  [ ] llm.paramOverrides                     (already matches)
  [✓] plugin.image.defaultStyle anime → realistic (change)

  [ ] Include API keys (3 found in bundle)

  [Cancel] [Apply selected]
  ```
- User unchecks rows they want to skip. Zero selected = "Apply" is disabled.
- On apply: `store.import(bundle, { keys: selectedKeys, includeSecrets: checkbox })`.

### 8.3 Reset

- Per-group: `[Reset LLM settings]` button in each group header. Clears every `settings.set()` value for that group, falls back to defaults.
- Global: `[Reset all settings]` in Data group. Shows confirmation. Does not touch `keys.env` (reset API keys is a separate explicit action).

## 9. Cleanup (no migration)

Since the project has a single developer user, old `localStorage` data is **deleted**, not migrated.

On first boot of the new code:

```ts
const LEGACY_KEYS = [
  "covel:locale", "covel:appearance", "covel:slotConfig",
  "covel:customPresets", "covel:paramOverrides",
  "covel:capabilityOverrides", "covel:runtimePriority",
  "covel:providerKeys", "covel:storageMode",
  "covel:onboarded", "covel:onboardedVersion",
];
const LEGACY_KEY_PREFIXES = ["covel:runtimeBindings:"];

function cleanupLegacy(): void {
  for (const key of LEGACY_KEYS) localStorage.removeItem(key);
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (LEGACY_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      localStorage.removeItem(key);
    }
  }
}
```

Run once, guarded by a `covel:settings:cleaned-v1` flag. Boot proceeds with defaults. User reconfigures whatever they had before.

## 10. Session-scoped runtime bindings

`covel:runtimeBindings:<sessionId>` localStorage keys are **deleted**. The authoritative store is `SessionRecord.runtimeModelOverrides` (already a JSONB field on the server; current code already writes it alongside the localStorage version).

Changes:
- `useRuntimeBindings` hook: remove `getRuntimeBindings` / `setRuntimeBindings` from `services/api.ts`.
- Hook now reads from fetched session state and writes via `api.updateSession({ runtimeModelOverrides })` only.
- `services/api.ts` exports `getRuntimeBindings`, `setRuntimeBindings`, `clearRuntimeBindings` → deleted.

This removes the last per-session `localStorage` key and makes the session the single source of truth for its own bindings.

## 11. File / Module Layout

```
packages/shared/src/settings/
├── types.ts             # SettingEntry, SettingsStore interface, bundle types
├── store.ts             # Core store impl (registry + cache + subscribers)
├── backends/
│   ├── json-file.ts     # Desktop adapter (IPC + REST)
│   └── localstorage.ts  # Web adapter
├── registries/
│   ├── core.ts          # ui.*, app.*
│   ├── llm.ts           # llm.*
│   ├── desktop.ts       # desktop.*
│   └── plugin.ts        # helpers to register plugin.<id>.* from manifest
└── index.ts

apps/web/src/components/settings/
├── SettingsDialog.tsx        # Shell (replaces current settings-dialog.tsx)
├── SettingsNavigation.tsx    # Left tree + search
├── SettingsContent.tsx       # Right pane dispatcher
├── widgets/
│   ├── TextWidget.tsx
│   ├── SelectWidget.tsx
│   ├── SliderWidget.tsx
│   ├── ToggleWidget.tsx
│   ├── SecretWidget.tsx
│   └── ...
├── ImportExportPane.tsx
└── useSettings.ts            # React hook wrapping the store
```

Old files deleted:
- `apps/web/src/components/settings-dialog.tsx` (replaced)
- `apps/web/src/components/settings-desktop-tab.tsx` (contents absorbed into new Desktop group)
- `apps/web/src/hooks/useAppearance.ts` (thin wrapper over `settings.get("ui.appearance")`; delete and inline)
- `apps/web/src/hooks/useLocalePreference.ts` (same)
- `apps/web/src/lib/appearance.ts` (move constants into settings registry)
- `apps/web/src/i18n/locale-detector.ts` (keep only `SUPPORTED_LOCALES` / `isSupportedLocale`; storage functions delete)
- `apps/web/src/services/data-service.ts` — `STORAGE_MODE_KEY` code (deprecated bucket)
- Numerous functions in `apps/web/src/services/api.ts` (getSlotConfig / setSlotConfig / getCustomPresets / getParamOverrides / getCapabilityOverrides / getRuntimeBindings / setRuntimeBindings / clearRuntimeBindings / getRuntimePriorityOverrides / setRuntimePriorityOverrides / getProviderKeys / setProviderKeys / loadProviderKeysFromStorage / ...).

## 12. Migration Path for Code

Incremental — not a single big-bang PR:

1. **PR A: Core store, no consumers.** Add `packages/shared/src/settings/`, unit-test against both backends.
2. **PR B: Registry + UI shell.** Register all core settings; new `SettingsDialog` renders but is behind a feature flag; old dialog still active.
3. **PR C: Consumer migration.** Delete old hooks / functions. All call sites switch to `useSettings()`. Legacy cleanup runs on first boot.
4. **PR D: Plugin userSettings.** Extend PLUGIN.md schema, runtime context injection, one plugin (e.g., image) adopts it as a demo.
5. **PR E: Import / Export + Reset.** Ships the Data group.
6. **PR F: Session runtimeBindings migration.** Deletes `localStorage` fallback path.

Each PR leaves the app fully functional.

## 13. Testing

- **Unit**: `packages/shared/src/settings/__tests__/store.test.ts` covers register, get, set, subscribe, import / export round-trip, secret exclusion.
- **Contract**: both backends pass the same test suite.
- **E2E** (Playwright): open Settings, change locale / appearance, export, reload, import, verify restored. Run under both Electron (IPC) and web (`localStorage`).

## 14. Open Questions

_None — all decisions finalized in the brainstorming session._

## 15. Decisions Log

| # | Decision | Rationale |
|---|---|---|
| 1 | Four-file layout (keys.env + llm.toml + config.toml + settings.json) | Each file keeps its specialty; keys keep mode-600 protection; llm.toml stays hand-editable |
| 2 | Auto-save (no Save button) | Consistency; fixes current mixed behavior; matches macOS / VS Code idiom |
| 3 | Flat key-value with registry | Minimal API; single list for UI; import/export trivial |
| 4 | Plugin namespace `plugin.<id>.*` + PLUGIN.md `userSettings` | Extensible; plugin authors can expose settings without framework changes |
| 5 | Left-nav + right-content UI with search + deep link | Scales to many plugins; searchable; `openSettings("llm.slots")` API useful everywhere |
| 6 | No data migration; delete legacy keys | Project is early, single user; migration code is dead weight |
| 7 | Web uses `localStorage` (single `covel:settings` key) | Sync API, negligible size, simplest impl |
| 8 | Delete `runtimeBindings:<sessionId>` localStorage; use `SessionRecord.runtimeModelOverrides` | Already exists server-side; removes last per-session localStorage key |
| 9 | Export defaults exclude keys; opt-in checkbox | Exported files often get shared / committed; secrets must be explicit |
| 10 | Import shows diff preview + selective apply | Low blast radius; users understand what they'll overwrite |
| 11 | Default appearance is `paper` (not `modern`) | Paper is Covel's primary visual identity; new users should experience it first. Changeable via General → Appearance. |
| 12 | Global subscribers in `main.tsx` for `ui.locale` / `ui.appearance` | The hooks (`useLocalePreference`, `useAppearance`) only fire their `useEffect` when a consumer component is mounted. Changes from the new SelectWidget path bypass those hooks entirely — without a global subscriber, swapping appearance from Settings would not re-apply `data-appearance` until the next mount. |
| 13 | Prep-phase runtime bindings keyed by worldId under `llm.prepRuntimeBindings` | The prep screen has no SessionRecord yet, so transient overrides need a home. Settings store is the natural place; cleared at session creation. |
