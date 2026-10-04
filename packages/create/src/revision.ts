/**
 * World revision — what the model is asked for, and how its answer is laid
 * over the world that exists.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { WorldRevision, WorldSections } from "./types.js";
import { isRecord } from "./validation-helpers.js";

const UNCHANGED = /^\s*UNCHANGED\s*\.?\s*$/i;

/** What the model is asked for when it revises a world. */
export function revisionRequest(revision: WorldRevision): string {
  const { current, instruction } = revision;
  return [
    "Revise the world package below. Change only what this request asks for:",
    "",
    instruction.trim(),
    "",
    "Return the three sections in the same format, and write only what you change:",
    "- A section that the request does not change: write the single word UNCHANGED as its body.",
    "- In WORLD_YAML, write only the fields you change. In `dimensions`, write only the dimensions you change, each one whole. A field or a dimension you leave out stays as it is.",
    "- In WORLD_PACKAGE_YAML, write only the items you add or change, under their list (`characters`, `lorebook`, `rules`, `contractData`). An item is matched by its `id` (in `contractData`, by `contract` and `key`) and is written whole. An item or a list you leave out stays as it is. To remove an item, write it as `{ id: <its id>, remove: true }`.",
    "- Do not rewrite text that the request does not concern. Keep the `id` of the world.",
    "",
    "===WORLD_YAML===",
    current.yaml.trim(),
    "===WORLD_MD===",
    current.lore.trim(),
    "===WORLD_PACKAGE_YAML===",
    (current.packageYaml ?? "{}").trim(),
    "===END===",
  ].join("\n");
}

/** Parse a section as a YAML mapping; undefined when it is not one. */
function mapping(
  text: string | undefined,
): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = parseYaml(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The manifest after a revision: the fields the model wrote, over the
 * current ones. `dimensions` is merged one dimension at a time, so a request
 * about one dimension does not have to repeat the others; `null` removes one.
 */
function mergeManifest(
  current: Record<string, unknown>,
  revised: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...current, ...revised };
  if (isRecord(current.dimensions) || isRecord(revised.dimensions)) {
    const dimensions: Record<string, unknown> = {
      ...(isRecord(current.dimensions) ? current.dimensions : {}),
      ...(isRecord(revised.dimensions) ? revised.dimensions : {}),
    };
    for (const [id, definition] of Object.entries(dimensions))
      if (definition === null) delete dimensions[id];
    merged.dimensions = dimensions;
  }
  return merged;
}

/** What names an item of a package list: its id, or contract and key. */
function itemKey(list: string, item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  if (list === "contractData")
    return typeof item.contract === "string" && typeof item.key === "string"
      ? `${item.contract}/${item.key}`
      : undefined;
  return typeof item.id === "string" ? item.id : undefined;
}

/**
 * A list after a revision: the items the model wrote replace the ones of the
 * same id or are added at the end, `remove: true` takes one out, and every
 * item it did not write stays as it is. A request to add one character then
 * cannot alter the others.
 */
function mergeList(
  list: string,
  current: readonly unknown[],
  revised: readonly unknown[],
): unknown[] {
  const written = new Map<string, unknown>();
  const unnamed: unknown[] = [];
  for (const item of revised) {
    const key = itemKey(list, item);
    if (key === undefined) unnamed.push(item);
    else written.set(key, item);
  }
  const removed = (item: unknown) => isRecord(item) && item.remove === true;
  const merged: unknown[] = [];
  for (const item of current) {
    const key = itemKey(list, item);
    const next = key === undefined ? undefined : written.get(key);
    if (key !== undefined) written.delete(key);
    if (next === undefined) merged.push(item);
    else if (!removed(next)) merged.push(next);
  }
  return [
    ...merged,
    ...[...written.values()].filter((item) => !removed(item)),
    // An item with no id is passed on; the checks report it.
    ...unnamed,
  ];
}

/** The package after a revision: each list the model wrote, merged into the current one. */
function mergePackage(
  current: Record<string, unknown>,
  revised: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...current };
  for (const [key, value] of Object.entries(revised)) {
    if (typeof value === "string" && UNCHANGED.test(value)) continue;
    merged[key] =
      Array.isArray(value) && Array.isArray(current[key])
        ? mergeList(key, current[key], value)
        : value;
  }
  return merged;
}

/**
 * The sections of the revised world: what the model wrote, over what the
 * world has. A section it marks `UNCHANGED`, a field or a list it does not
 * write, stays as it is. This is what keeps a request to "add a character"
 * from dropping the lore entries the model did not repeat.
 *
 * A section that does not parse is passed on as written, so that the checks
 * report it and the model is asked again.
 */
export function mergeRevision(
  output: WorldSections,
  current: WorldSections,
): WorldSections {
  const merge = (
    written: string | undefined,
    existing: string | undefined,
    combine: typeof mergeManifest,
  ): string | undefined => {
    if (written === undefined || UNCHANGED.test(written)) return existing;
    const revised = mapping(written);
    const base = mapping(existing);
    return revised && base
      ? stringifyYaml(combine(base, revised), { lineWidth: 0 })
      : written;
  };
  const packageYaml = merge(
    output.packageYaml,
    current.packageYaml,
    mergePackage,
  );
  return {
    yaml: merge(output.yaml, current.yaml, mergeManifest) ?? output.yaml,
    lore: UNCHANGED.test(output.lore) ? current.lore : output.lore,
    ...(packageYaml !== undefined ? { packageYaml } : {}),
  };
}
