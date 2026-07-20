/**
 * Runtime-side helpers that need framework types but do not own the main turn
 * orchestration loop.
 */

import type { EventBus } from "@covel/events";
import type { AssetProgressInput, PluginSource } from "@covel/plugin-loader";
import type {
  RuntimeManifest,
  RuntimeResult,
  ToolCallRecord,
} from "@covel/shared";
import type { RuntimeOutputRecord } from "@covel/store";
import type { TurnEmitter } from "../trace/turn-emitter.js";

export interface PluginSourceDeps {
  readonly getPluginSource?: (pluginId: string) => PluginSource | undefined;
}

/** Emit a subscription-style event via the EventBus if present. */
export function emitSubEvent(
  eventBus: EventBus | undefined,
  subTopic: string,
  subType: string,
  sessionId: string,
  payload: Record<string, unknown>,
): void {
  if (!eventBus) return;
  eventBus.emit({
    id: crypto.randomUUID(),
    type: "event",
    topic: subTopic,
    sessionId,
    timestamp: new Date().toISOString(),
    payload: { ...payload, _subTopic: subTopic, _subType: subType },
  });
}

/**
 * Trust is derived EXCLUSIVELY from the immutable discovery registry
 * (`getPluginSource` — set from the plugin's load path at boot, never from
 * plugin-supplied data). The old fallback trusted the manifest's own
 * `pluginType === "core-plugin"` claim, which is author-supplied and was
 * reachable with a forged manifest — handing untrusted code the full
 * un-scoped DataStore. No registry answer ⇒
 * NOT trusted; callers without a `getPluginSource` dep get the scoped
 * capability view, which is the safe default.
 */
export function isTrustedPluginSource(
  deps: PluginSourceDeps,
  manifest: RuntimeManifest,
): boolean {
  const source = deps.getPluginSource?.(manifest.pluginId);
  return source === "builtin" || source === "official";
}

export function createAssetProgressEmitter(
  emitter: TurnEmitter | undefined,
  identity: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly pluginId: string;
    readonly runtimeId: string;
  },
): ((progress: AssetProgressInput) => Promise<void>) | undefined {
  if (!emitter) return undefined;
  return async (progress) => {
    const phase = progress.phase.trim();
    if (phase.length === 0) {
      throw new Error("assetProgress.phase must be a non-empty string");
    }
    if (
      progress.percent !== undefined &&
      (!Number.isFinite(progress.percent) ||
        progress.percent < 0 ||
        progress.percent > 100)
    ) {
      throw new Error("assetProgress.percent must be a number from 0 to 100");
    }

    await emitter.emit("asset.progress", {
      ...identity,
      ...(progress.assetId ? { assetId: progress.assetId } : {}),
      phase,
      ...(progress.percent === undefined ? {} : { percent: progress.percent }),
      ...(progress.message ? { message: progress.message } : {}),
      ...(progress.modality ? { modality: progress.modality } : {}),
      ...(progress.meta === undefined ? {} : { meta: progress.meta }),
    });
  };
}

/**
 * PR-1 translation layer: convert a `RuntimeResult` into a normalized
 * `RuntimeOutputRecord` for downstream consumers.
 */
export function buildRuntimeOutputFromResult(
  rr: RuntimeResult,
  sessionId: string,
  turn: number,
  createdAt: string,
): RuntimeOutputRecord {
  const output = rr.output as Record<string, unknown> | null;

  const narrativeOutput =
    output && typeof output["narrativeOutput"] === "string"
      ? (output["narrativeOutput"] as string)
      : null;
  const textValue =
    output && typeof output["_text"] === "string"
      ? (output["_text"] as string)
      : null;
  const summaryText =
    narrativeOutput ?? textValue ?? (output ? JSON.stringify(output) : "");

  const toolCallList = rr.toolCalls.map((tc: ToolCallRecord) => ({
    tool: tc.toolName,
    input: tc.input,
    output: tc.output,
    status: "success" as const,
    durationMs: tc.durationMs,
  }));

  return {
    id: crypto.randomUUID(),
    sessionId,
    turnId: rr.turnId,
    runtimeResultId: rr.runId,
    pluginId: rr.pluginId,
    runtimeId: rr.runtimeId,
    timestamp: rr.timestamp ?? createdAt,
    results: [
      {
        text: summaryText,
        structured: output ?? undefined,
      },
    ],
    metaData: {
      turn,
      toolCallList: toolCallList.length > 0 ? toolCallList : undefined,
      tokenUsage: rr.tokenUsage,
    },
    createdAt,
  };
}
