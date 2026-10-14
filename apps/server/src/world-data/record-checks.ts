/**
 * Checks of the records of a world package that need more than their schema:
 * a value that names an attribute or a dimension of the world, and a field no
 * model reads. All are static: they read the main file of each structured
 * source.
 */

import path from "node:path";
import type { PluginRegistry } from "@covel/plugin-loader";
import {
  modelHiddenPaths,
  type DimensionValueSchema,
  type ModelHiddenReason,
  type WorldDimensions,
} from "@covel/shared";
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

interface PathNode {
  readonly value: unknown;
  readonly holder?: Record<string, unknown>;
  readonly at: string;
}

/** A node and every object or list item below it, outermost first. */
function descendants(node: PathNode): PathNode[] {
  const found: PathNode[] = [node];
  const { value } = node;
  if (Array.isArray(value))
    for (const [index, item] of value.entries())
      found.push(...descendants({ value: item, at: `${node.at}[${index}]` }));
  else if (isRecord(value))
    for (const [name, child] of Object.entries(value))
      if (child !== null && typeof child === "object")
        found.push(
          ...descendants({
            value: child,
            at: node.at ? `${node.at}.${name}` : name,
          }),
        );
  return found;
}

/**
 * The values a reference `path` (`attributes[].id`, `when.**.dimension`)
 * names in one record.
 */
function referringValues(
  record: unknown,
  referencePath: string,
  pointer: string,
): ReferringValue[] {
  let nodes: PathNode[] = [{ value: record, at: pointer }];
  for (const segment of referencePath.split(".")) {
    if (segment === "**") {
      nodes = nodes.flatMap(descendants);
      continue;
    }
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

type Finding = Pick<WorldPackageDiagnostic, "pointer" | "message" | "hint">;

/** The pointer of a field beside the one at `pointer`. */
function siblingPointer(pointer: string, field: string): string {
  return pointer.replace(/[^.[\]]+(?:\[\d+\])?$/, field);
}

function checkAttributeReference(
  item: ReferringValue,
  pluginId: string,
  reference: DataReference,
  attributes: readonly ReferencedAttribute[],
): Finding[] {
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
  const findings: Finding[] = [];
  for (const field of reference.within ?? []) {
    const value = item.holder[field];
    if (typeof value !== "number") continue;
    const below = attribute.min !== undefined && value < attribute.min;
    const above = attribute.max !== undefined && value > attribute.max;
    if (!below && !above) continue;
    findings.push({
      pointer: siblingPointer(item.pointer, field),
      message: `\`${field}: ${value}\` is ${below ? `below the \`min\` (${attribute.min})` : `above the \`max\` (${attribute.max})`} of attribute "${id}"; plugin "${pluginId}" fails on it when a session starts`,
      hint: `Keep \`${field}\` inside the \`min\` and \`max\` that world.yaml gives "${id}", or change that range.`,
    });
  }
  return findings;
}

function typesOf(schema: DimensionValueSchema): readonly string[] {
  return schema.type === undefined
    ? []
    : typeof schema.type === "string"
      ? [schema.type]
      : schema.type;
}

/**
 * Why `segments` cannot reach a value the dimension's schema allows, or
 * undefined when they can (or the schema does not say). Only a place the
 * schema rules out is reported: a closed object without that property, an
 * index into something that is not a list, a key below a scalar.
 */
function unreachablePath(
  schema: DimensionValueSchema,
  segments: readonly string[],
): { readonly at: string; readonly reason: string } | undefined {
  let node: DimensionValueSchema | undefined = schema;
  const walked: string[] = [];
  for (const segment of segments) {
    if (!node) return undefined;
    const at = walked.length ? walked.join(".") : "the value";
    const types = typesOf(node);
    const list = types.includes("array");
    const object = types.includes("object");
    // Object keywords alone do not exclude arrays. If both containers are
    // possible, this conservative check cannot rule out a path through either.
    if (!types.length || (list && object)) return undefined;
    if (list) {
      if (!/^\d+$/.test(segment))
        return { at, reason: `${at} is a list, read by index` };
      node = node.items;
    } else if (object) {
      if (node.properties && Object.hasOwn(node.properties, segment))
        node = node.properties[segment];
      else if (node.additionalProperties === false)
        return {
          at,
          reason: `${at} has no \`${segment}\`${
            node.properties
              ? `; it has ${Object.keys(node.properties).join(", ")}`
              : ""
          }`,
        };
      else
        node =
          typeof node.additionalProperties === "object"
            ? node.additionalProperties
            : undefined;
    } else if (types.length) {
      return {
        at,
        reason: `${at} is of type ${types.join(" or ")} and has no fields`,
      };
    } else return undefined;
    walked.push(segment);
  }
  return undefined;
}

function checkDimensionReference(
  item: ReferringValue,
  pluginId: string,
  reference: DataReference,
  dimensions: WorldDimensions,
): Finding[] {
  // A value of another shape is the schema's finding.
  if (typeof item.value !== "string") return [];
  const id = item.value;
  const declared = Object.keys(dimensions);
  const dimension = Object.hasOwn(dimensions, id) ? dimensions[id] : undefined;
  if (!dimension)
    return [
      {
        pointer: item.pointer,
        message: `"${id}" is not a dimension this world declares; plugin "${pluginId}" finds nothing under that name in a session`,
        hint: declared.length
          ? `Use the ID of a dimension the world declares: ${declared.join(", ")}.`
          : "Declare the dimension in data/dimensions.yaml or under `dimensions` in world.yaml.",
      },
    ];
  const findings: Finding[] = [];
  for (const field of reference.within ?? []) {
    const value = item.holder[field];
    const segments =
      typeof value === "string"
        ? value.split(".").filter((segment) => segment !== "")
        : Array.isArray(value) &&
            value.every(
              (segment) =>
                typeof segment === "string" || typeof segment === "number",
            )
          ? value.map(String)
          : undefined;
    if (!segments?.length) continue;
    const unreachable = unreachablePath(dimension.schema, segments);
    if (!unreachable) continue;
    findings.push({
      pointer: siblingPointer(item.pointer, field),
      message: `\`${field}: ${segments.join(".")}\` is not a place in dimension "${id}": ${unreachable.reason}; plugin "${pluginId}" never finds a value there`,
      hint: `Use a path that the \`schema\` of "${id}" allows.`,
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
 * Three checks of each record of the structured sources:
 *
 * - `attribute-reference`: a value that a receiving plugin declares as the
 *   name of a character attribute (`authoring.references`) must name one of
 *   `attributes`, of the declared type and range. `attributes` is undefined
 *   for a world without a `characterSchema`: its attributes are only known
 *   once a session has generated them.
 * - `dimension-reference`: a value declared as the ID of a world dimension
 *   must name one of `dimensions`, and a path beside it must be one the
 *   dimension's schema allows. `dimensions` is undefined when the world
 *   declares none (a session may generate them) or they could not be read
 *   (reported on its own).
 * - `model-hidden-field`: a field that reads as the time a row was written,
 *   or an ID that is a UUID, is left out of everything a model reads.
 */
export async function checkWorldRecords(options: {
  readonly worldDir: string;
  readonly sources: readonly OrderedWorldDataSource[];
  readonly catalogue: PluginCatalogue;
  readonly attributes: readonly ReferencedAttribute[] | undefined;
  readonly dimensions: WorldDimensions | undefined;
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
      target?.kind === "contract-data"
        ? referencesOf(options.catalogue, target.contract)
        : [];
    const listed = Array.isArray(main.value);
    for (const [index, record] of sourceItems(main.value).entries()) {
      const location = recordLocation(source, record, index, listed);
      const at = location.pointer ?? "";
      for (const { pluginId, reference } of references) {
        const { attributes, dimensions } = options;
        const check =
          reference.to === "world-dimension"
            ? dimensions &&
              ((item: ReferringValue) =>
                checkDimensionReference(item, pluginId, reference, dimensions))
            : attributes &&
              ((item: ReferringValue) =>
                checkAttributeReference(item, pluginId, reference, attributes));
        if (!check) continue;
        const code =
          reference.to === "world-dimension"
            ? "dimension-reference"
            : "attribute-reference";
        for (const item of referringValues(record, reference.path, at))
          for (const finding of check(item))
            diagnostics.push({
              level: "error",
              code,
              file,
              sourceId: source.id,
              ...finding,
            });
      }
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
