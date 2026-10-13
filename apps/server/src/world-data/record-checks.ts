/**
 * Checks of the records of a world package that need more than their schema:
 * a value that names an attribute of the world, and a field no model reads.
 * Both are static: they read the main file of each structured source.
 */

import path from "node:path";
import type { PluginRegistry } from "@covel/plugin-loader";
import { modelHiddenPaths, type ModelHiddenReason } from "@covel/shared";
import {
  isRecord,
  recordLocation,
  sourceItems,
} from "./session-import/utils.js";
import { readWorldDataSource } from "./source-reader.js";
import { parseWorldDataTarget } from "./target-uri.js";
import type { OrderedWorldDataSource } from "./types.js";
import type { WorldPackageDiagnostic } from "./validate-world-package.js";

type PluginCatalogue = Pick<PluginRegistry, "getAll">;
type DataDeclaration = NonNullable<
  NonNullable<
    NonNullable<
      NonNullable<ReturnType<PluginRegistry["get"]>>["packageManifest"]
    >["plugin"]["contributes"]
  >["data"]
>[string];
type DataReference = NonNullable<
  NonNullable<DataDeclaration["authoring"]>["references"]
>[number];

/** The part of a `characterSchema` attribute a reference is checked against. */
export interface ReferencedAttribute {
  readonly id: string;
  readonly type: string;
  readonly min?: number;
  readonly max?: number;
}

interface ReferringValue {
  readonly value: unknown;
  /** The object that holds the field, where `within` fields are read. */
  readonly holder: Record<string, unknown>;
  readonly pointer: string;
}

/** The values a reference `path` (`attributes[].id`) names in one record. */
function referringValues(
  record: unknown,
  referencePath: string,
  pointer: string,
): ReferringValue[] {
  let nodes: {
    value: unknown;
    holder?: Record<string, unknown>;
    at: string;
  }[] = [{ value: record, at: pointer }];
  for (const segment of referencePath.split(".")) {
    const listed = segment.endsWith("[]");
    const name = listed ? segment.slice(0, -2) : segment;
    nodes = nodes.flatMap((node) => {
      if (!isRecord(node.value) || !Object.hasOwn(node.value, name)) return [];
      const holder = node.value;
      const child = holder[name];
      const at = node.at ? `${node.at}.${name}` : name;
      if (!listed) return [{ value: child, holder, at }];
      return Array.isArray(child)
        ? child.map((item, index) => ({
            value: item,
            holder,
            at: `${at}[${index}]`,
          }))
        : [];
    });
  }
  return nodes.flatMap((node) =>
    node.holder
      ? [{ value: node.value, holder: node.holder, pointer: node.at }]
      : [],
  );
}

/** The references that the receivers of a data contract declare. */
function referencesOf(
  catalogue: PluginCatalogue,
  contract: string,
): { pluginId: string; reference: DataReference }[] {
  const found: { pluginId: string; reference: DataReference }[] = [];
  for (const [pluginId, entry] of catalogue.getAll()) {
    if (entry.status === "error") continue;
    for (const declaration of Object.values(
      entry.packageManifest?.plugin?.contributes?.data ?? {},
    )) {
      if (!declaration.accepts?.includes(contract)) continue;
      for (const reference of declaration.authoring?.references ?? [])
        found.push({ pluginId, reference });
    }
  }
  return found;
}

function checkReference(
  item: ReferringValue,
  pluginId: string,
  reference: DataReference,
  attributes: readonly ReferencedAttribute[],
): Pick<WorldPackageDiagnostic, "pointer" | "message" | "hint">[] {
  // A value of another shape is the schema's finding.
  if (typeof item.value !== "string") return [];
  const id = item.value;
  const fitting = attributes
    .filter((attribute) => !reference.type || attribute.type === reference.type)
    .map((attribute) => attribute.id);
  const kind = reference.type ? `${reference.type} attribute` : "attribute";
  const choose =
    fitting.length > 0
      ? `Use the \`id\` of a ${kind} of \`characterSchema.attributes\` in world.yaml: ${fitting.join(", ")}.`
      : `Add a ${kind} with this \`id\` to \`characterSchema.attributes\` in world.yaml.`;
  const attribute = attributes.find((candidate) => candidate.id === id);
  if (!attribute)
    return [
      {
        pointer: item.pointer,
        message: `"${id}" is not an attribute of this world's characterSchema; plugin "${pluginId}" fails on it when a session starts`,
        hint: choose,
      },
    ];
  if (reference.type && attribute.type !== reference.type)
    return [
      {
        pointer: item.pointer,
        message: `attribute "${id}" has type ${attribute.type}, and plugin "${pluginId}" needs a ${kind} here; it fails on it when a session starts`,
        hint: choose,
      },
    ];
  const findings: Pick<
    WorldPackageDiagnostic,
    "pointer" | "message" | "hint"
  >[] = [];
  for (const field of reference.within ?? []) {
    const value = item.holder[field];
    if (typeof value !== "number") continue;
    const below = attribute.min !== undefined && value < attribute.min;
    const above = attribute.max !== undefined && value > attribute.max;
    if (!below && !above) continue;
    findings.push({
      pointer: item.pointer.replace(/[^.[\]]+(?:\[\d+\])?$/, field),
      message: `\`${field}: ${value}\` is ${below ? `below the \`min\` (${attribute.min})` : `above the \`max\` (${attribute.max})`} of attribute "${id}"; plugin "${pluginId}" fails on it when a session starts`,
      hint: `Keep \`${field}\` inside the \`min\` and \`max\` that world.yaml gives "${id}", or change that range.`,
    });
  }
  return findings;
}

/** What a `model-hidden-field` warning says, by the reason the field is hidden. */
const HIDDEN_FIELD_TEXT = {
  time: (label: string, field: string) => ({
    message: `${label}: \`${field}\` is named like the time a row was written and holds an ISO time, so no model reads it`,
    hint: "If it is a date of the story, rename the field (`date`, `diedOn`) or write the value in another form than an ISO time. Otherwise remove it.",
  }),
  uuid: (label: string, field: string) => ({
    message: `${label}: \`${field}\` holds a UUID, which reads as the ID of a stored row, so no model reads it`,
    hint: "Give it an ID a person can read, in lower-case words and hyphens (`npc-lin-yao`). A model matches records by such an ID or by name.",
  }),
} satisfies Record<
  ModelHiddenReason,
  (label: string, field: string) => { message: string; hint: string }
>;

/**
 * Two checks of each record of the structured sources:
 *
 * - `attribute-reference`: a value that a receiving plugin declares as the
 *   name of a character attribute (`authoring.references`) must name one of
 *   `attributes`, of the declared type and range. `attributes` is undefined
 *   for a world without a `characterSchema`: its attributes are only known
 *   once a session has generated them.
 * - `model-hidden-field`: a field that reads as the time a row was written,
 *   or an ID that is a UUID, is left out of everything a model reads.
 */
export async function checkWorldRecords(options: {
  readonly worldDir: string;
  readonly sources: readonly OrderedWorldDataSource[];
  readonly catalogue: PluginCatalogue;
  readonly attributes: readonly ReferencedAttribute[] | undefined;
}): Promise<WorldPackageDiagnostic[]> {
  const diagnostics: WorldPackageDiagnostic[] = [];
  for (const source of options.sources) {
    const { kind } = source.descriptor;
    if (
      source.inlineValue !== undefined ||
      (kind !== "json" && kind !== "yaml")
    )
      continue;
    const main = await readWorldDataSource(source);
    if (!main.path || main.value === undefined) continue;
    const file = path.relative(options.worldDir, main.path);
    const target = parseWorldDataTarget(source.descriptor.to);
    const references =
      target?.kind === "contract-data" && options.attributes
        ? referencesOf(options.catalogue, target.contract)
        : [];
    const listed = Array.isArray(main.value);
    for (const [index, record] of sourceItems(main.value).entries()) {
      const location = recordLocation(source, record, index, listed);
      const at = location.pointer ?? "";
      for (const { pluginId, reference } of references)
        for (const item of referringValues(record, reference.path, at))
          for (const finding of checkReference(
            item,
            pluginId,
            reference,
            options.attributes ?? [],
          ))
            diagnostics.push({
              level: "error",
              code: "attribute-reference",
              file,
              sourceId: source.id,
              ...finding,
            });
      for (const { path: hidden, reason } of modelHiddenPaths(record)) {
        const field = hidden.slice(hidden.lastIndexOf(".") + 1);
        diagnostics.push({
          level: "warning",
          code: "model-hidden-field",
          file,
          sourceId: source.id,
          pointer:
            at && !hidden.startsWith("[") ? `${at}.${hidden}` : at + hidden,
          ...HIDDEN_FIELD_TEXT[reason](location.label, field),
        });
      }
    }
  }
  return diagnostics;
}
