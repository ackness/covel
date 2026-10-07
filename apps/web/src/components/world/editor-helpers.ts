import type { TFunction } from "i18next";
import i18n from "@/i18n/index.js";
import {
  worldDimensionsSchema,
  worldGeographySchema,
  worldFactionSchema,
  worldPowerSystemSchema,
  worldHistoryEventSchema,
  worldEconomySchema,
  worldSocialStructureSchema,
  worldToneSchema,
  worldMechanicsSchema,
  worldStartingConditionsSchema,
  type JsonValue,
  type WorldDimensions,
  type WorldGeography,
  type WorldFaction,
  type WorldPowerSystem,
  type WorldHistoryEvent,
  type WorldEconomy,
  type WorldSocialStructure,
  type WorldTone,
  type WorldMechanics,
  type WorldStartingConditions,
} from "@covel/shared";
import { z } from "zod";
import { resolveDisplayText } from "@/lib/i18n-text.js";

type I18nText = string | Record<string, string>;

export function text(v: I18nText | undefined, locale?: string): string {
  return resolveDisplayText(v, locale ?? i18n.language);
}

/** Whether a world's name, summary or tags contain the search text. */
export function matchesWorldQuery(
  world: {
    readonly name: I18nText;
    readonly description: I18nText;
    readonly tags?: readonly string[];
  },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  return (
    !needle ||
    [text(world.name), text(world.description), ...(world.tags ?? [])]
      .join("\n")
      .toLowerCase()
      .includes(needle)
  );
}

/** Shared input class names */
export const inputCls =
  "w-full border border-border bg-background px-3 py-2 text-sm";
export const textareaCls =
  "w-full border border-border bg-background px-3 py-2 text-sm min-h-20 resize-y";
export const selectCls = "border border-border bg-background px-3 py-2 text-sm";

/**
 * One starting resource while the form edits it. The saved value is an object
 * keyed by name, which cannot hold an empty name or the same name twice, and
 * a name passes through both while it is typed. A row keeps its place and its
 * value through that; the object is built from the rows at save.
 */
export interface ResourceRow {
  readonly id: string;
  readonly name: string;
  readonly value: number;
}

let resourceRowCounter = 0;

export function newResourceRow(name = "", value = 0): ResourceRow {
  resourceRowCounter += 1;
  return { id: `resource-${resourceRowCounter}`, name, value };
}

/** Starting conditions as the form edits them. */
export type StartingConditionsDraft = Omit<
  WorldStartingConditions,
  "startingResources"
> & {
  readonly startingResources?: readonly ResourceRow[];
};

/**
 * What the form tabs edit. The nine authoring templates are examples, never
 * the dimension contract. A value here is a draft: it has the shape of its
 * template, but it may be incomplete until the save checks it.
 */
export interface DimensionsState {
  geography?: WorldGeography;
  factions?: WorldFaction[];
  powerSystem?: WorldPowerSystem;
  history?: WorldHistoryEvent[];
  economy?: WorldEconomy;
  socialStructure?: WorldSocialStructure;
  tone?: WorldTone;
  mechanics?: WorldMechanics;
  startingConditions?: StartingConditionsDraft;
}
export const dimensionTemplateSchemas = {
  geography: worldGeographySchema,
  factions: z.array(worldFactionSchema),
  powerSystem: worldPowerSystemSchema,
  history: z.array(worldHistoryEventSchema),
  economy: worldEconomySchema,
  socialStructure: worldSocialStructureSchema,
  tone: worldToneSchema,
  mechanics: worldMechanicsSchema,
  startingConditions: worldStartingConditionsSchema,
};

function startingConditionsDraft(
  saved: WorldStartingConditions,
): StartingConditionsDraft {
  const { startingResources, ...rest } = saved;
  return startingResources
    ? {
        ...rest,
        startingResources: Object.entries(startingResources).map(
          ([name, value]) => newResourceRow(name, value),
        ),
      }
    : rest;
}

/**
 * The saved form of the draft. A row without a name has no key to go under,
 * and of two rows with one name only the first can; the save does not run
 * while the rows have such a problem.
 */
function startingConditionsValue(
  draft: StartingConditionsDraft,
): WorldStartingConditions {
  const { startingResources, ...rest } = draft;
  if (!startingResources) return rest;
  const byName = new Map<string, number>();
  for (const row of startingResources) {
    const name = row.name.trim();
    if (name && !byName.has(name)) byName.set(name, row.value);
  }
  return { ...rest, startingResources: Object.fromEntries(byName) };
}

/**
 * What is wrong with the name of one resource row. A name that another row
 * has is a problem as soon as it is typed. An empty name is one only at save:
 * a new row starts with it.
 */
export function resourceNameProblem(
  rows: readonly ResourceRow[],
  index: number,
  t: TFunction,
  atSave = false,
): string | undefined {
  const name = rows[index]?.name.trim();
  if (!name)
    return atSave
      ? t("world.resourceNameMissing", "Name this resource, or remove it.")
      : undefined;
  return rows.some((row, other) => other !== index && row.name.trim() === name)
    ? t("world.resourceNameRepeated", "Another resource has this name.")
    : undefined;
}

/**
 * The drafts the form tabs start from. A dimension has one only when its
 * value fits the template; the editor shows the others as JSON.
 */
export function projectDimensionTemplates(
  dimensions: WorldDimensions,
): DimensionsState {
  const {
    startingConditions,
    ...rest
  }: Omit<DimensionsState, "startingConditions"> & {
    startingConditions?: WorldStartingConditions;
  } = Object.fromEntries(
    Object.entries(dimensionTemplateSchemas).flatMap(([id, schema]) => {
      const result = schema.safeParse(dimensions[id]?.initialValue);
      return result.success ? [[id, result.data]] : [];
    }),
  );
  return startingConditions
    ? {
        ...rest,
        startingConditions: startingConditionsDraft(startingConditions),
      }
    : rest;
}

/**
 * The dimensions as a save sends them: the definitions, with each draft as
 * the value of its dimension. A tab the player started from nothing gets a
 * definition that accepts any value.
 */
export function mergeDimensionDrafts(
  dimensions: WorldDimensions,
  drafts: DimensionsState,
  t: TFunction,
): WorldDimensions {
  const { startingConditions, ...rest } = drafts;
  const values: Record<string, unknown> = startingConditions
    ? {
        ...rest,
        startingConditions: startingConditionsValue(startingConditions),
      }
    : rest;
  return {
    ...dimensions,
    ...Object.fromEntries(
      Object.entries(values).flatMap(([id, value]) =>
        value === undefined
          ? []
          : [
              [
                id,
                {
                  ...(dimensions[id] ?? { name: t(`world.${id}`), schema: {} }),
                  // A form writes `undefined` for an optional field the
                  // player cleared. JSON has no such value: the field is
                  // left out.
                  initialValue: JSON.parse(JSON.stringify(value)) as JsonValue,
                },
              ],
            ],
      ),
    ),
  };
}

/**
 * What stops a save in one tab: a message by the path of its field in the
 * tab's value, such as `regions` or `tiers.0.rank`.
 */
export type FieldProblems = Readonly<Record<string, string>>;

export interface DimensionProblems {
  /** By the ID of a form tab. A tab without problems has no entry. */
  readonly tabs: Readonly<Record<string, FieldProblems>>;
  /** Problems in what only the JSON editor shows. */
  readonly other: readonly string[];
}

/** The message for a template rule a form can break; any other as written. */
function templateIssueMessage(issue: z.core.$ZodIssue, t: TFunction): string {
  if (issue.code === "too_small" && issue.origin === "array")
    return t("world.listNeedsEntry", "Add at least one entry.");
  if (
    issue.code === "too_small" &&
    (issue.origin === "number" || issue.origin === "int")
  )
    return t("world.numberTooSmall", "Enter {{minimum}} or more.", {
      minimum: Number(issue.minimum),
    });
  if (issue.code === "invalid_type" && issue.expected === "int")
    return t("world.wholeNumberNeeded", "Enter a whole number.");
  return issue.message;
}

/**
 * The full check, which runs at save and not while the player types: each
 * draft against its template, the resource names, then every dimension
 * against its own declared schema.
 */
export function dimensionProblems(
  merged: WorldDimensions,
  drafts: DimensionsState,
  t: TFunction,
): DimensionProblems {
  const tabs: Record<string, Record<string, string>> = {};
  const other: string[] = [];
  // The first message at a path stays: the template names the rule in the
  // player's language, and the declared schema can repeat it.
  function add(id: string, path: readonly PropertyKey[], message: string) {
    (tabs[id] ??= {})[path.map(String).join(".")] ??= message;
  }
  for (const [id, schema] of Object.entries(dimensionTemplateSchemas)) {
    if (!Object.hasOwn(drafts, id)) continue;
    const result = schema.safeParse(merged[id]?.initialValue);
    if (result.success) continue;
    for (const issue of result.error.issues)
      add(id, issue.path, templateIssueMessage(issue, t));
  }
  const rows = drafts.startingConditions?.startingResources ?? [];
  rows.forEach((_, index) => {
    const problem = resourceNameProblem(rows, index, t, true);
    if (problem)
      add("startingConditions", ["startingResources", index], problem);
  });
  const whole = worldDimensionsSchema.safeParse(merged);
  if (!whole.success)
    for (const issue of whole.error.issues) {
      const [id, field, ...path] = issue.path;
      if (
        typeof id === "string" &&
        field === "initialValue" &&
        Object.hasOwn(drafts, id)
      )
        add(id, path, issue.message);
      else
        other.push(
          [issue.path.map(String).join("."), issue.message]
            .filter(Boolean)
            .join(": "),
        );
    }
  return { tabs, other };
}

export interface TabProps {
  dimensions: DimensionsState;
  onChange: (next: DimensionsState) => void;
  t: TFunction;
  /** What stopped the last save in this tab. Absent before a save finds any. */
  problems?: FieldProblems;
}
