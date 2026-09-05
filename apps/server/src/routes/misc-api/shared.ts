import { relative } from "node:path";
import {
  DEFAULT_LOCALE,
  FrameworkCapability,
  resolveI18nText,
  type Stage,
} from "@covel/shared";

// Flow segments are the named stages plus one bucket for stage-less runtimes
// (event / manual). The frontend groups steps by `step.segmentId === segment.id`
// and renders each segment's `labelText`. Segment ids ARE the stage names so a
// staged step maps 1:1; the framework never assumes "priority 500 == narrator".
export type FlowSegmentId = Stage | "event-manual";

export type UiSlotName = "right" | "message" | "left";

export { bearerToken } from "../privileged-auth.js";

export function textValue(
  value: unknown,
  locale: string = DEFAULT_LOCALE,
): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const localized = Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    return resolveI18nText(localized, locale) ?? "";
  }
  return "";
}

export function docPathFromAbsolute(
  pluginsDir: string,
  absolutePath: string,
): string {
  return `plugins/${relative(pluginsDir, absolutePath).replace(/\\/g, "/")}`;
}

export function uiSlotsOf(manifest: {
  ui?: {
    right?: readonly string[];
    message?: readonly string[];
    left?: readonly string[];
  };
}): string[] {
  const slots: string[] = [];
  if (manifest.ui?.right?.length) slots.push("right");
  if (manifest.ui?.message?.length) slots.push("message");
  if (manifest.ui?.left?.length) slots.push("left");
  return slots;
}

export function isStoryRuntime(manifest: {
  outputKind?: string;
  capabilities?: readonly string[];
}): boolean {
  return (
    manifest.outputKind === "story" ||
    manifest.capabilities?.includes(FrameworkCapability.Narrative) === true
  );
}

export function normalizeRuntimeTrigger(trigger?: {
  type?: string;
  interval?: number;
  cooldownTurns?: number;
  maxTriggerCount?: number;
  startTurn?: number;
  topic?: string;
}): {
  type: string;
  interval?: number;
  cooldownTurns?: number;
  maxTriggerCount?: number;
  startTurn?: number;
  topic?: string;
} {
  return {
    type: trigger?.type ?? "auto",
    ...(trigger?.interval !== undefined ? { interval: trigger.interval } : {}),
    ...(trigger?.cooldownTurns !== undefined
      ? { cooldownTurns: trigger.cooldownTurns }
      : {}),
    ...(trigger?.maxTriggerCount !== undefined
      ? { maxTriggerCount: trigger.maxTriggerCount }
      : {}),
    ...(trigger?.startTurn !== undefined
      ? { startTurn: trigger.startTurn }
      : {}),
    ...(trigger?.topic !== undefined ? { topic: trigger.topic } : {}),
  };
}
