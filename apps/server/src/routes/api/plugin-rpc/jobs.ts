import type { DataStore } from "@covel/store";

export type PluginJobValue = Readonly<Record<string, unknown>> & {
  readonly status: "pending" | "done" | "failed";
  readonly progress: number;
};

export interface PluginJobTriggerEvent {
  readonly topic: string;
  readonly data: Readonly<Record<string, unknown>>;
}

interface PluginJobValueBaseArgs {
  readonly runtimeId: string;
  readonly turnId: string;
  readonly startedAt: string;
  readonly payload?: unknown;
  readonly triggerEvent?: PluginJobTriggerEvent;
  readonly phase?: string;
  readonly message?: string;
  readonly messageKey?: string;
}

interface PendingPluginJobValueArgs extends PluginJobValueBaseArgs {
  readonly progress?: number;
}

interface TerminalPluginJobValueArgs extends PluginJobValueBaseArgs {
  readonly status: "done" | "failed";
  readonly progress?: number;
  readonly completedAt: string;
  readonly durationMs?: number;
  readonly runtimeResults?: readonly unknown[];
  readonly deferredJobs?: readonly unknown[];
  readonly error?: string;
  readonly abortReason?: string;
  readonly reason?: string;
}

function addDefined(
  value: Record<string, unknown>,
  key: string,
  item: unknown,
): void {
  if (item !== undefined) value[key] = item;
}

export function makePendingPluginJobValue(
  args: PendingPluginJobValueArgs,
): PluginJobValue {
  const value: Record<string, unknown> = {
    status: "pending",
    progress: args.progress ?? 5,
    runtimeId: args.runtimeId,
    turnId: args.turnId,
  };
  addDefined(value, "payload", args.payload);
  addDefined(value, "triggerEvent", args.triggerEvent);
  value.startedAt = args.startedAt;
  addDefined(value, "phase", args.phase);
  addDefined(value, "message", args.message);
  addDefined(value, "messageKey", args.messageKey);
  return value as PluginJobValue;
}

export function makeTerminalPluginJobValue(
  args: TerminalPluginJobValueArgs,
): PluginJobValue {
  const value: Record<string, unknown> = {
    status: args.status,
    progress: args.progress ?? 100,
    runtimeId: args.runtimeId,
    turnId: args.turnId,
  };
  addDefined(value, "payload", args.payload);
  addDefined(value, "triggerEvent", args.triggerEvent);
  value.startedAt = args.startedAt;
  value.completedAt = args.completedAt;
  addDefined(value, "durationMs", args.durationMs);
  addDefined(value, "phase", args.phase);
  addDefined(value, "message", args.message);
  addDefined(value, "messageKey", args.messageKey);
  addDefined(value, "runtimeResults", args.runtimeResults);
  addDefined(value, "deferredJobs", args.deferredJobs);
  addDefined(value, "error", args.error);
  addDefined(value, "abortReason", args.abortReason);
  addDefined(value, "reason", args.reason);
  return value as PluginJobValue;
}

export interface WritePluginJobArgs {
  readonly sessionId: string;
  readonly pluginId: string;
  readonly jobId: string;
  readonly startedAt: string;
  readonly updatedAt?: string;
  readonly value: PluginJobValue;
}

export async function writePluginJob(
  store: DataStore,
  args: WritePluginJobArgs,
): Promise<void> {
  await store.setPluginData({
    id: `${args.sessionId}:${args.pluginId}:_jobs:${args.jobId}`,
    sessionId: args.sessionId,
    pluginId: args.pluginId,
    namespace: "_jobs",
    key: args.jobId,
    value: args.value,
    createdAt: args.startedAt,
    updatedAt: args.updatedAt ?? args.startedAt,
  });
}
