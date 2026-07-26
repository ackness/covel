import type { SettingsStoreApi } from "@covel/settings";
import { DEFAULT_COLOR_SCHEME } from "@/lib/appearance.js";
import { THEME_SCHEME_KEY } from "./registry.js";
import {
  getTokenSpec,
  isAdjustableToken,
  listAdjustableTokens,
} from "./token-schema.js";
import type { ThemeScheme } from "./types.js";

/**
 * Player token overrides — a thin layer *on top of* the selected theme.
 *
 * The theme still owns the whole design; this only re-points individual custom
 * properties as inline styles on `<html>`, which outrank any stylesheet rule
 * without touching the theme's CSS. Removing an override restores the theme
 * value exactly, because nothing was ever rewritten.
 */

export const APPEARANCE_TOKENS_KEY = "ui.appearanceTokens";

/** Colours live per scheme; sizes, fonts and radii are shared across both. */
export interface AppearanceOverrides {
  readonly shared: Readonly<Record<string, string>>;
  readonly light: Readonly<Record<string, string>>;
  readonly dark: Readonly<Record<string, string>>;
}

export const EMPTY_OVERRIDES: AppearanceOverrides = {
  shared: {},
  light: {},
  dark: {},
};

/**
 * A CSS value long enough to matter is a bug or an abuse (a pasted data-URL
 * would push the settings blob past the localStorage quota and take every
 * other setting down with it).
 */
const MAX_VALUE_LENGTH = 2048;

type OverrideBucket = keyof AppearanceOverrides;

function bucketFor(tokenName: string, scheme: ThemeScheme): OverrideBucket {
  return getTokenSpec(tokenName)?.perScheme ? scheme : "shared";
}

/**
 * Keep only known tokens with sane string values. Overrides are unregistered
 * settings, so `SettingsStore.import` waves them through unvalidated — a shared
 * settings backup is untrusted input and this is the only chokepoint.
 */
function normalizeBucket(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > MAX_VALUE_LENGTH) continue;
    if (!isAdjustableToken(name)) continue;
    out[name] = trimmed;
  }
  return out;
}

export function loadOverrides(store: SettingsStoreApi): AppearanceOverrides {
  const raw = store.get<unknown>(APPEARANCE_TOKENS_KEY);
  if (!raw || typeof raw !== "object") return EMPTY_OVERRIDES;
  const record = raw as Record<string, unknown>;
  return {
    shared: normalizeBucket(record.shared),
    light: normalizeBucket(record.light),
    dark: normalizeBucket(record.dark),
  };
}

async function saveOverrides(
  store: SettingsStoreApi,
  next: AppearanceOverrides,
): Promise<void> {
  await store.set(APPEARANCE_TOKENS_KEY, next);
}

function currentScheme(store: SettingsStoreApi): ThemeScheme {
  const scheme = store.get<ThemeScheme>(THEME_SCHEME_KEY);
  return scheme === "light" || scheme === "dark"
    ? scheme
    : DEFAULT_COLOR_SCHEME;
}

/** Flatten to what should actually be on the element right now. */
export function resolveActiveOverrides(
  overrides: AppearanceOverrides,
  scheme: ThemeScheme,
): Record<string, string> {
  return { ...overrides.shared, ...overrides[scheme] };
}

/**
 * Properties currently written to `<html>`, so a later pass can remove the
 * ones that went away instead of leaving orphans behind.
 */
let appliedProperties: readonly string[] = [];

export function applyTokenOverrides(store: SettingsStoreApi): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const active = resolveActiveOverrides(
    loadOverrides(store),
    currentScheme(store),
  );

  for (const name of appliedProperties) {
    if (!(name in active)) root.style.removeProperty(name);
  }
  for (const [name, value] of Object.entries(active)) {
    // An invalid value is dropped by the CSSOM, which is the failure mode we
    // want: the theme's own value simply stays in effect.
    root.style.setProperty(name, value);
  }
  appliedProperties = Object.keys(active);
}

/**
 * The value each token would have with no override applied — what the
 * controls show as their baseline and what "reset" returns to.
 *
 * Overrides are lifted for the read and restored in the same synchronous
 * block, so the browser never paints the intermediate state.
 */
export function readTokenDefaults(): Record<string, string> {
  if (typeof document === "undefined") return {};
  const root = document.documentElement;
  const lifted = appliedProperties.map(
    (name) => [name, root.style.getPropertyValue(name)] as const,
  );

  for (const [name] of lifted) root.style.removeProperty(name);
  const computed = getComputedStyle(root);
  const defaults: Record<string, string> = {};
  for (const name of listAdjustableTokens()) {
    defaults[name] = computed.getPropertyValue(name).trim();
  }
  for (const [name, value] of lifted) root.style.setProperty(name, value);

  return defaults;
}

export async function setTokenOverride(
  store: SettingsStoreApi,
  tokenName: string,
  value: string,
): Promise<void> {
  if (!isAdjustableToken(tokenName)) return;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_VALUE_LENGTH) return;

  const current = loadOverrides(store);
  const bucket = bucketFor(tokenName, currentScheme(store));
  await saveOverrides(store, {
    ...current,
    [bucket]: { ...current[bucket], [tokenName]: trimmed },
  });
}

export async function clearTokenOverride(
  store: SettingsStoreApi,
  tokenName: string,
): Promise<void> {
  const current = loadOverrides(store);
  const bucket = bucketFor(tokenName, currentScheme(store));
  if (!(tokenName in current[bucket])) return;

  const { [tokenName]: _removed, ...rest } = current[bucket];
  await saveOverrides(store, { ...current, [bucket]: rest });
}

/** Clear one group's tokens, or everything when no names are given. */
export async function clearOverrides(
  store: SettingsStoreApi,
  tokenNames?: readonly string[],
): Promise<void> {
  if (!tokenNames) {
    await saveOverrides(store, EMPTY_OVERRIDES);
    return;
  }
  const drop = new Set(tokenNames);
  const strip = (
    bucket: Readonly<Record<string, string>>,
  ): Record<string, string> =>
    Object.fromEntries(
      Object.entries(bucket).filter(([name]) => !drop.has(name)),
    );

  const current = loadOverrides(store);
  await saveOverrides(store, {
    shared: strip(current.shared),
    light: strip(current.light),
    dark: strip(current.dark),
  });
}

/** Override for `tokenName` in the scheme currently on screen, if any. */
export function getTokenOverride(
  overrides: AppearanceOverrides,
  tokenName: string,
  scheme: ThemeScheme,
): string | null {
  return overrides[bucketFor(tokenName, scheme)][tokenName] ?? null;
}

export function countOverrides(overrides: AppearanceOverrides): number {
  return (
    Object.keys(overrides.shared).length +
    Object.keys(overrides.light).length +
    Object.keys(overrides.dark).length
  );
}

/** Replace the whole set at once — used by preset application and import. */
export async function replaceOverrides(
  store: SettingsStoreApi,
  next: AppearanceOverrides,
): Promise<void> {
  await saveOverrides(store, {
    shared: normalizeBucket(next.shared),
    light: normalizeBucket(next.light),
    dark: normalizeBucket(next.dark),
  });
}
