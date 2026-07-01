import { resolve, relative } from "node:path";
import { FrameworkCapability, readRuntimeEnv } from "@covel/shared";
import {
  discoverPluginsMulti,
  type PluginDiscoveryResult,
} from "@covel/plugin-loader";

// audit A5: segment ids are neutral priority-band labels. The framework must
// not assume "priority 500 == narrator" — narrator is a plugin whose priority
// is manifest-configured, not framework knowledge. The frontend groups steps
// by the segment's priority range (minPriority/maxPriority) and renders its
// `labelText`/`label`; it never reads the segment `id`, so neutral ids are safe.
export type FlowSegmentId =
  | "start"
  | "pre-game"
  | "priority-band-pre-narrator"
  | "priority-band-narrator"
  | "priority-band-post-narrator";

export type UiSlotName = "right" | "message" | "left";

export const UI_NAMESPACE_BY_SLOT: Record<UiSlotName, string> = {
  right: "__ui_right__",
  message: "__ui_message__",
  left: "__ui_left__",
};

export { bearerToken } from "../privileged-auth.js";

/**
 * All plugin directories the server should scan — bundled first, user
 * install dir second. Mirrors `apps/server/src/app.ts:199` so `/api/ui-specs`
 * and sibling endpoints see the same plugin set the kernel bootstrapped
 * against. Without this, user-installed plugins (e.g. ~/.covel/plugins/*)
 * never get their UI specs materialised into `plugin_data.__ui_right__`
 * and the frontend right panel silently drops their buttons.
 */

export function resolvePluginsDirs(): readonly string[] {
  const env = readRuntimeEnv();
  const bundled =
    env.pluginsDir ?? resolve(import.meta.dirname, "../../../../../plugins");
  const dirs = [bundled];
  if (env.userPluginsDir && env.userPluginsDir !== bundled) {
    dirs.push(env.userPluginsDir);
  }
  return dirs;
}

export function textValue(value: unknown, locale = "zh-CN"): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, string>;
    return record[locale] ?? record["en-US"] ?? Object.values(record)[0] ?? "";
  }
  return "";
}

export function segmentForPriority(priority: number): FlowSegmentId {
  // audit P0-1: align with packages/runtime/src/scheduler.ts band edges.
  // Pre-Game is `0-99` (turn 0 only), main loop is `100-1000`. Treating
  // `priority === 100` as Pre-Game would put it in the wrong band on the
  // flow viz — same drift the audit calls out.
  if (priority <= 0) return "start";
  if (priority <= 99) return "pre-game";
  if (priority < 500) return "priority-band-pre-narrator";
  if (priority === 500) return "priority-band-narrator";
  return "priority-band-post-narrator";
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
  condition?: string;
  maxRetryCount?: number;
}): {
  type: string;
  interval?: number;
  cooldownTurns?: number;
  maxTriggerCount?: number;
  startTurn?: number;
  topic?: string;
  condition?: string;
  maxRetryCount?: number;
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
    ...(trigger?.condition !== undefined
      ? { condition: trigger.condition }
      : {}),
    ...(trigger?.maxRetryCount !== undefined
      ? { maxRetryCount: trigger.maxRetryCount }
      : {}),
  };
}

export async function loadPluginDiscovery(
  pluginId: string,
): Promise<PluginDiscoveryResult | undefined> {
  const discoveries = await discoverPluginsMulti(resolvePluginsDirs());
  return discoveries.find((item) => item.id === pluginId);
}
