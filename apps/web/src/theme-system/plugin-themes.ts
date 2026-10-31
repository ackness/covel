import { z } from "zod";
import type { SettingsStoreApi } from "@covel/settings";
import {
  PLUGIN_THEME_TOKENS,
  pluginAssetUrl,
  resolvedPluginThemeEntrySchema,
  resolvedPluginThemeSchema,
  scopeCompiledPluginThemeCss,
  type PluginThemePart,
  type ResolvedPluginTheme,
} from "@covel/shared";
import { storedThemeSelection } from "./selection.js";
import {
  applyThemeLayout,
  resolveThemeLayout,
  type ResolvedThemeLayout,
} from "./layout.js";
import {
  APPEARANCE_TOKENS_KEY,
  loadOverrides,
  resolveActiveOverrides,
} from "./overrides.js";
import { CUSTOM_THEMES_KEY } from "./storage.js";
import type { PluginThemeSource } from "./types.js";

const identity = resolvedPluginThemeSchema.shape;
export const sessionThemeChoiceSchema = z.strictObject({
  pluginId: identity.pluginId.max(128),
  themeId: identity.id,
  contentHash: identity.contentHash,
});
export type SessionThemeChoice = z.infer<typeof sessionThemeChoiceSchema>;
export const sessionThemeKey = (sessionId: string) =>
  `ui.sessionTheme.${sessionId}`;
export interface SessionThemePack {
  readonly theme: ResolvedPluginTheme;
  readonly owner: string;
}
export interface PluginThemeState {
  readonly packs: readonly SessionThemePack[];
  readonly selected: SessionThemeChoice | null;
  readonly effective: PluginThemeSource | null;
  readonly status: "loading" | "ready" | "error";
  readonly hydrated: boolean;
  readonly saving: boolean;
  readonly error: "save" | "off-save" | "resource" | null;
}
const EMPTY: PluginThemeState = {
  packs: [],
  selected: null,
  effective: null,
  status: "loading",
  hydrated: false,
  saving: false,
  error: null,
};
interface Registry {
  current?: PluginThemeSession;
  revision: number;
  listeners: Set<() => void>;
}
const registries = new WeakMap<SettingsStoreApi, Registry>();
function registry(store: SettingsStoreApi): Registry {
  let entry = registries.get(store);
  if (!entry) {
    entry = { revision: 0, listeners: new Set() };
    registries.set(store, entry);
  }
  return entry;
}
export function subscribePluginThemes(
  store: SettingsStoreApi,
  listener: () => void,
) {
  const entry = registry(store);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}
export const pluginThemeRevision = (store: SettingsStoreApi) =>
  registry(store).revision;
export function currentPluginThemeSession(
  store: SettingsStoreApi,
  sessionId?: string,
) {
  const current = registry(store).current;
  return current && (sessionId === undefined || current.sessionId === sessionId)
    ? current
    : undefined;
}
export function resolveSessionThemeLayout(
  store: SettingsStoreApi,
  base: ResolvedThemeLayout,
): ResolvedThemeLayout {
  const layout = registry(store).current?.state.effective?.theme.layout;
  if (!layout) return base;
  const preset = resolveThemeLayout(layout);
  return {
    ...base,
    panelTabs: preset.panelTabs,
    backdrop: preset.backdrop,
    turnNotes: preset.turnNotes,
  };
}
export function effectivePluginPalette(
  store: SettingsStoreApi,
  theme: ResolvedPluginTheme,
) {
  const scheme = storedThemeSelection(store).scheme;
  const overrides = resolveActiveOverrides(loadOverrides(store), scheme);
  return Object.fromEntries(
    PLUGIN_THEME_TOKENS.flatMap((name) => {
      const value = overrides[name] ?? theme.tokens?.[scheme]?.[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}
const pendingChoices = new WeakMap<
  SettingsStoreApi,
  Map<string, { token: symbol; confirmed: SessionThemeChoice | null }>
>();
function pendingFor(store: SettingsStoreApi) {
  let pending = pendingChoices.get(store);
  if (!pending) {
    pending = new Map();
    pendingChoices.set(store, pending);
  }
  return pending;
}
let mountSequence = 0;

/** One store-owned, ephemeral source. Disposers and writes retain their owner. */
export class PluginThemeSession {
  readonly scope = (++mountSequence).toString(16).padStart(64, "0");
  state: PluginThemeState = EMPTY;
  private confirmed: SessionThemeChoice | null = null;
  private blocked = false;
  private mutation = 0;
  private pendingWrites = 0;
  private generation = 0;
  private alive = true;
  private style?: HTMLStyleElement;
  private resources = new Map<string, Promise<boolean>>();
  private readyResources = new Set<string>();
  private resourceAbort = new AbortController();
  private unsubscribe: () => void;

  constructor(
    readonly store: SettingsStoreApi,
    readonly sessionId: string,
  ) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId))
      throw new Error("Invalid session identity");
    const entry = registry(store);
    entry.current?.dispose();
    entry.current = this;
    store.register({
      key: sessionThemeKey(sessionId),
      schema: sessionThemeChoiceSchema.nullable(),
      default: null,
      group: "general",
      widget: "custom",
      label: "Session appearance",
    });
    this.unsubscribe = store.subscribeAll((_value, key) => {
      if (!this.alive) return;
      if (
        key === sessionThemeKey(sessionId) &&
        !this.state.saving &&
        this.pendingWrites === 0
      )
        this.readChoice();
      if (
        [
          sessionThemeKey(sessionId),
          "ui.appearance",
          "ui.scheme",
          CUSTOM_THEMES_KEY,
          APPEARANCE_TOKENS_KEY,
        ].includes(key)
      )
        this.publish();
    });
    void store.ready().then(() => {
      if (!this.alive) return;
      this.state = { ...this.state, hydrated: store.isHydrated() };
      this.readChoice();
      this.publish();
    });
    this.publish();
  }
  private readChoice() {
    const pending = pendingFor(this.store).get(this.sessionId);
    if (pending) {
      this.confirmed = pending.confirmed;
      return;
    }
    const parsed = sessionThemeChoiceSchema.safeParse(
      this.store.get(sessionThemeKey(this.sessionId)),
    );
    this.confirmed = parsed.success ? parsed.data : null;
  }
  /** Unknown active sets and refreshes retire every piece of the old source. */
  replace(
    packs: readonly SessionThemePack[],
    status: PluginThemeState["status"],
  ) {
    if (!this.alive) return;
    this.generation++;
    this.resourceAbort.abort();
    this.resourceAbort = new AbortController();
    this.resources.clear();
    this.readyResources.clear();
    this.mutation++;
    if (this.pendingWrites === 0) this.readChoice();
    const accepted: SessionThemePack[] = [];
    const seen = new Set<string>();
    for (const pack of packs) {
      const parsed = resolvedPluginThemeEntrySchema.safeParse({
        pluginId: pack.theme.pluginId,
        specs: [pack.theme],
      });
      const theme = parsed.success ? parsed.data.specs[0] : undefined;
      if (!theme) continue;
      const key = JSON.stringify([theme.pluginId, theme.id]);
      if (seen.has(key)) continue;
      seen.add(key);
      accepted.push({ theme, owner: pack.owner });
    }
    this.state = {
      ...this.state,
      packs: status === "ready" ? accepted : [],
      status,
      saving: false,
      error: this.state.error === "resource" ? null : this.state.error,
    };
    this.publish();
  }
  private publish() {
    if (!this.alive || registry(this.store).current !== this) return;
    const selected = this.confirmed;
    const pack =
      !this.blocked &&
      this.state.hydrated &&
      this.state.status === "ready" &&
      selected
        ? this.state.packs.find(
            ({ theme }) =>
              theme.pluginId === selected.pluginId &&
              theme.id === selected.themeId &&
              theme.contentHash === selected.contentHash,
          )
        : undefined;
    const resourceReady =
      !pack?.theme.assets || this.readyResources.has(pack.theme.contentHash);
    if (pack && !resourceReady) void this.prepareResources(pack.theme);
    this.state = {
      ...this.state,
      selected,
      effective:
        pack && resourceReady
          ? {
              source: "plugin",
              pluginId: pack.theme.pluginId,
              themeId: pack.theme.id,
              contentHash: pack.theme.contentHash,
              theme: pack.theme,
              owner: pack.owner,
            }
          : null,
    };
    this.syncStyle();
    applyThemeLayout(
      resolveSessionThemeLayout(
        this.store,
        resolveThemeLayout(storedThemeSelection(this.store).theme?.layout),
      ),
    );
    const entry = registry(this.store);
    entry.revision++;
    for (const listener of entry.listeners) listener();
  }
  private prepareResources(theme: ResolvedPluginTheme): Promise<boolean> {
    if (!theme.assets) return Promise.resolve(true);
    const previous = this.resources.get(theme.contentHash);
    if (previous) return previous;
    const generation = this.generation;
    const signal = AbortSignal.any([
      this.resourceAbort.signal,
      AbortSignal.timeout(10_000),
    ]);
    const task = Promise.all(
      theme.assets.files.map(async (file) => {
        const response = await fetch(
          pluginAssetUrl(theme.pluginId, theme.assets!.digest, file.path),
          {
            method: "HEAD",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            mode: "same-origin",
            redirect: "error",
            signal,
          },
        );
        return (
          response.ok &&
          response.headers.get("content-type")?.split(";")[0] === file.mime &&
          Number(response.headers.get("content-length")) === file.size
        );
      }),
    )
      .then(
        (results) => results.every(Boolean),
        () => false,
      )
      .then((ready) => {
        if (
          !this.alive ||
          generation !== this.generation ||
          this.resources.get(theme.contentHash) !== task
        )
          return false;
        if (ready) this.readyResources.add(theme.contentHash);
        if (
          !this.blocked &&
          this.confirmed?.contentHash === theme.contentHash
        ) {
          if (!ready) this.state = { ...this.state, error: "resource" };
          this.publish();
        }
        return ready;
      });
    this.resources.set(theme.contentHash, task);
    return task;
  }
  private syncStyle() {
    const theme = this.state.effective?.theme;
    if (!theme || typeof document === "undefined") {
      this.style?.remove();
      this.style = undefined;
      return;
    }
    const checked =
      theme.cssText === undefined
        ? undefined
        : scopeCompiledPluginThemeCss(
            theme.cssText,
            {
              pluginId: theme.pluginId,
              scope: theme.contentHash,
              assets: theme.assets,
            },
            this.scope,
          );
    if (checked && !checked.success) {
      this.state = { ...this.state, effective: null };
      this.style?.remove();
      this.style = undefined;
      return;
    }
    const selector = (part: PluginThemePart) =>
      `[data-covel-theme-scope="${this.scope}"][data-covel-theme-part="${part}"]`;
    const palette = document.createElement("span").style;
    for (const [name, value] of Object.entries(
      effectivePluginPalette(this.store, theme),
    ))
      palette.setProperty(name, value);
    const text = document.createElement("span").style;
    const overrides = resolveActiveOverrides(
      loadOverrides(this.store),
      storedThemeSelection(this.store).scheme,
    );
    const typography: Record<string, string> = {
      "--story-font-family": "font-family",
      "--story-font-size": "font-size",
      "--story-line-height": "line-height",
      "--story-font-weight": "font-weight",
      "--story-letter-spacing": "letter-spacing",
      "--story-color": "color",
    };
    for (const [token, property] of Object.entries(typography)) {
      const value = overrides[token];
      if (value) text.setProperty(property, value, "important");
    }
    const targets = ["story", "dialogue", "surface"]
      .map((part) => selector(part as PluginThemePart))
      .join(",");
    const prose = `${selector("story")},${selector("dialogue")}`;
    const css = `${targets}{${palette.cssText}}${prose}{color:var(--story-color);}${checked?.success ? checked.css : ""}${prose}{${text.cssText}}`;
    if (!this.style) {
      this.style = document.createElement("style");
      this.style.dataset.pluginThemeStyle = this.scope;
      document.head.appendChild(this.style);
    }
    this.style.textContent = css;
  }
  async select(choice: SessionThemeChoice | null): Promise<boolean> {
    if (!this.alive) return false;
    if (choice !== null) {
      const parsed = sessionThemeChoiceSchema.safeParse(choice);
      if (
        !parsed.success ||
        !this.state.hydrated ||
        !this.state.packs.some(
          ({ theme }) =>
            theme.pluginId === choice.pluginId &&
            theme.id === choice.themeId &&
            theme.contentHash === choice.contentHash,
        )
      )
        return false;
    }
    const mutation = ++this.mutation;
    const token = Symbol();
    pendingFor(this.store).set(this.sessionId, {
      token,
      confirmed: choice === null ? null : this.confirmed,
    });
    const generation = this.generation;
    if (choice === null) this.blocked = true;
    this.state = { ...this.state, saving: true, error: null };
    this.publish();
    this.pendingWrites++;
    try {
      const pack =
        choice &&
        this.state.packs.find(
          ({ theme }) =>
            theme.pluginId === choice.pluginId &&
            theme.id === choice.themeId &&
            theme.contentHash === choice.contentHash,
        );
      if (pack && !(await this.prepareResources(pack.theme))) {
        if (
          this.alive &&
          mutation === this.mutation &&
          generation === this.generation
        ) {
          this.state = { ...this.state, saving: false, error: "resource" };
          this.publish();
        }
        return false;
      }
      if (
        !this.alive ||
        mutation !== this.mutation ||
        generation !== this.generation
      )
        return false;
      if (choice === null)
        await this.store.clear(sessionThemeKey(this.sessionId));
      else await this.store.set(sessionThemeKey(this.sessionId), choice);
      if (
        !this.alive ||
        mutation !== this.mutation ||
        generation !== this.generation
      )
        return false;
      if (pendingFor(this.store).get(this.sessionId)?.token === token)
        pendingFor(this.store).delete(this.sessionId);
      this.blocked = false;
      this.readChoice();
      this.state = { ...this.state, saving: false, error: null };
      this.publish();
      return true;
    } catch {
      if (
        !this.alive ||
        mutation !== this.mutation ||
        generation !== this.generation
      )
        return false;
      if (pendingFor(this.store).get(this.sessionId)?.token === token)
        pendingFor(this.store).delete(this.sessionId);
      // The store owns conflict resolution. Read its confirmed rollback, never merge.
      this.readChoice();
      this.state = {
        ...this.state,
        saving: false,
        error: choice === null ? "off-save" : "save",
      };
      this.publish();
      return false;
    } finally {
      this.pendingWrites--;
      const pending = pendingFor(this.store);
      if (pending.get(this.sessionId)?.token === token) {
        pending.delete(this.sessionId);
        const current = registry(this.store).current;
        if (
          current &&
          current !== this &&
          current.sessionId === this.sessionId &&
          !current.state.saving
        ) {
          current.readChoice();
          current.publish();
        }
      }
    }
  }
  dispose() {
    if (!this.alive) return;
    this.alive = false;
    this.resourceAbort.abort();
    this.mutation++;
    this.unsubscribe?.();
    this.style?.remove();
    const entry = registry(this.store);
    if (entry.current !== this) return;
    entry.current = undefined;
    applyThemeLayout(
      resolveThemeLayout(storedThemeSelection(this.store).theme?.layout),
    );
    entry.revision++;
    for (const listener of entry.listeners) listener();
  }
}
