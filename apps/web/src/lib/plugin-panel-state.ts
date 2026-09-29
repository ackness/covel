import type { StateStore } from "@json-render/react";

/** Copy a bounded JSON draft so callers cannot mutate the cached snapshot. */
export function parsePluginUiState(
  value: unknown,
): Record<string, unknown> | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("UI state must be an object or null");
  }
  const encoded = JSON.stringify(value, (_key, child: unknown) => {
    if (
      (typeof child === "number" && !Number.isFinite(child)) ||
      ["undefined", "function", "symbol", "bigint"].includes(typeof child) ||
      (child !== null &&
        typeof child === "object" &&
        !Array.isArray(child) &&
        Object.getPrototypeOf(child) !== Object.prototype &&
        Object.getPrototypeOf(child) !== null)
    ) {
      throw new Error("UI state must contain JSON values");
    }
    return child;
  });
  if (new TextEncoder().encode(encoded).byteLength > 32 * 1024) {
    throw new Error("UI state exceeds 32 KiB");
  }
  const snapshot: unknown = JSON.parse(encoded);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("UI state must be an object or null");
  }
  return snapshot as Record<string, unknown>;
}

export function buildPluginPanelInitialState(
  data: Record<string, unknown>,
  invokingMap: Record<string, true>,
  sources: Record<string, Record<string, unknown>> = {},
): Record<string, unknown> {
  const entries = Object.entries(data).map(([key, value]) => ({ key, value }));
  return {
    ...expandIndexedState(data),
    entries,
    _invoking: invokingMap,
    sources,
  };
}

/** Resolve only explicitly named namespaces of the panel's owning plugin. */
export function resolvePluginPanelSources(
  ownerNamespaces: Readonly<Record<string, Record<string, unknown>>>,
  bindings: Readonly<Record<string, string>>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(bindings).map(([name, namespace]) => [
      name,
      Object.hasOwn(ownerNamespaces, namespace)
        ? (ownerNamespaces[namespace] ?? {})
        : {},
    ]),
  );
}

export function flattenStateForPluginPanel(
  value: Record<string, unknown>,
  previous: Record<string, unknown> = {},
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  for (const key of Object.keys(previous)) {
    if (!Object.hasOwn(value, key))
      updates[`/${escapePointer(key)}`] = undefined;
  }
  for (const [key, child] of Object.entries(value)) {
    const oldValue = Object.hasOwn(previous, key) ? previous[key] : undefined;
    if (Object.hasOwn(previous, key) && Object.is(child, oldValue)) continue;
    const path = `/${escapePointer(key)}`;
    if (key === "sources" || key === "_invoking") updates[path] = child;
    else flattenStateValue(updates, path, child, oldValue);
  }
  return updates;
}

// Keep the external snapshot with its cached store across panel unmounts.
// Diff against this snapshot, not the live store, to preserve local edits.
const externalSnapshots = new WeakMap<StateStore, Record<string, unknown>>();

export function syncPluginPanelState(
  store: StateStore,
  value: Record<string, unknown>,
): void {
  const updates = flattenStateForPluginPanel(
    value,
    externalSnapshots.get(store),
  );
  externalSnapshots.set(store, value);
  store.update(updates);
}

function escapePointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Mirrors the render-side cap in `catalog/core-renderers.tsx`. */
const MAX_FLATTEN_DEPTH = 32;

/** Compare external JSON snapshots without reading or overwriting local drafts. */
function sameExternalValue(
  value: unknown,
  previous: unknown,
  depth: number,
): boolean {
  if (Object.is(value, previous)) return true;
  if (
    depth >= MAX_FLATTEN_DEPTH ||
    !value ||
    !previous ||
    typeof value !== "object" ||
    typeof previous !== "object" ||
    Array.isArray(value) !== Array.isArray(previous)
  )
    return false;
  const keys = Object.keys(value);
  const oldRecord = previous as Record<string, unknown>;
  return (
    keys.length === Object.keys(previous).length &&
    (!Array.isArray(value) ||
      value.length === (previous as unknown[]).length) &&
    keys.every(
      (key) =>
        Object.hasOwn(oldRecord, key) &&
        sameExternalValue(
          (value as Record<string, unknown>)[key],
          oldRecord[key],
          depth + 1,
        ),
    )
  );
}

function flattenStateValue(
  updates: Record<string, unknown>,
  basePath: string,
  value: unknown,
  previous: unknown,
  depth = 0,
): void {
  if (Array.isArray(value)) {
    // Derived entries and refreshed server arrays may be reconstructed with
    // identical contents. Only an external content change replaces the draft.
    if (!sameExternalValue(value, previous, depth))
      updates[basePath || "/"] = value;
    return;
  }
  // Plugin data is unvalidated and arbitrarily deep. Past the cap, assign the
  // subtree wholesale rather than recursing into a stack overflow.
  if (value && typeof value === "object" && depth < MAX_FLATTEN_DEPTH) {
    const entries = Object.entries(value as Record<string, unknown>);
    const oldRecord =
      previous && typeof previous === "object" && !Array.isArray(previous)
        ? (previous as Record<string, unknown>)
        : undefined;
    if (entries.length === 0) {
      if (!oldRecord || Object.keys(oldRecord).length > 0)
        updates[basePath] = value;
      return;
    }
    // json-render infers an array when the next pointer segment is numeric.
    // Establish object containers explicitly before writing their children.
    if (!oldRecord) updates[basePath] = {};
    for (const key of Object.keys(oldRecord ?? {})) {
      if (!Object.hasOwn(value, key)) {
        updates[`${basePath}/${escapePointer(key)}`] = undefined;
      }
    }
    for (const [key, child] of entries) {
      const oldValue =
        oldRecord && Object.hasOwn(oldRecord, key) ? oldRecord[key] : undefined;
      if (
        oldRecord &&
        Object.hasOwn(oldRecord, key) &&
        Object.is(child, oldValue)
      )
        continue;
      flattenStateValue(
        updates,
        `${basePath}/${escapePointer(key)}`,
        child,
        oldValue,
        depth + 1,
      );
    }
    return;
  }
  updates[basePath || "/"] = value;
}

export function expandIndexedState(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const expanded: Record<string, unknown> = { ...data };

  for (const [key, value] of Object.entries(data)) {
    flattenIndexedValue(expanded, singularize(key), value);
  }

  return expanded;
}

function flattenIndexedValue(
  target: Record<string, unknown>,
  baseKey: string,
  value: unknown,
): void {
  if (!Array.isArray(value)) return;

  value.forEach((item, index) => {
    const itemKey = `${baseKey}${index + 1}`;
    if (Array.isArray(item)) {
      item.forEach((entry, entryIndex) => {
        target[`${itemKey}${entryIndex + 1}`] = entry;
      });
      return;
    }

    if (item && typeof item === "object") {
      for (const [childKey, childValue] of Object.entries(
        item as Record<string, unknown>,
      )) {
        const nestedKey = `${itemKey}${capitalize(childKey)}`;
        if (Array.isArray(childValue)) {
          flattenIndexedValue(target, nestedKey, childValue);
        } else if (childValue && typeof childValue === "object") {
          for (const [innerKey, innerValue] of Object.entries(
            childValue as Record<string, unknown>,
          )) {
            target[`${nestedKey}${capitalize(innerKey)}`] = innerValue;
          }
        } else {
          target[nestedKey] = childValue;
        }
      }
      return;
    }

    target[itemKey] = item;
  });
}

function singularize(value: string): string {
  if (value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.endsWith("s")) return value.slice(0, -1);
  return value;
}

function capitalize(value: string): string {
  return value.length > 0
    ? `${value[0].toUpperCase()}${value.slice(1)}`
    : value;
}
