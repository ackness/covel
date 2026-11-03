import type { RuntimeManifest } from "../types/plugin.js";

/**
 * Where a submitted output keeps its player-visible text: a JSON pointer to
 * an array of unit objects, an array of strings, or one string.
 */
export interface OutputDisplaySpec {
  readonly units: string;
  /** For an array of objects, the string field holding a unit's text. */
  readonly text?: string;
  /** For an array of objects, primitive fields sent with each unit. */
  readonly meta?: readonly string[];
}

export type DisplayMetaValue = string | number | boolean;

/** One paragraph or line of player-visible output. */
export interface DisplayUnit {
  readonly text: string;
  readonly meta?: Readonly<Record<string, DisplayMetaValue>>;
}

/** How much of a story shows while the model writes it. */
export type LiveOutputMode = "units" | "text";

export interface LiveOutputPlan {
  readonly mode: LiveOutputMode;
  readonly display: OutputDisplaySpec;
}

/** A story written as segments: one unit per segment. */
export const STORY_SEGMENTS_DISPLAY: OutputDisplaySpec = Object.freeze({
  units: "/segments",
  text: "text",
  meta: Object.freeze(["kind", "speaker"]),
});

/** A story written as one text. */
export const STORY_TEXT_DISPLAY: OutputDisplaySpec = Object.freeze({
  units: "/narrativeOutput",
});

/**
 * Whether a runtime's output shows while the model writes it, and where its
 * text lives. Only story output reaches players, and only output the model
 * writes into `submit-output` can show early: never a concealed or
 * presentation runtime, nor one that submits a tool result (`io.output.from`).
 * The text lives where every story keeps it: `segments` when the effective
 * schema has them, otherwise `narrativeOutput`.
 */
export function liveOutputPlan(
  manifest: RuntimeManifest,
  schema: Readonly<Record<string, unknown>>,
): LiveOutputPlan | undefined {
  const live = manifest.output?.live ?? "units";
  if (
    live === "off" ||
    manifest.runtimeType === "function" ||
    manifest.outputKind !== "story" ||
    manifest.concealed ||
    manifest.presentation ||
    manifest.output?.from
  )
    return undefined;
  const properties = schema.properties;
  const segments =
    properties && typeof properties === "object"
      ? (properties as Record<string, unknown>).segments
      : undefined;
  return {
    mode: live,
    display:
      segments && typeof segments === "object"
        ? STORY_SEGMENTS_DISPLAY
        : STORY_TEXT_DISPLAY,
  };
}
