import type { DataStore } from "@covel/store";

export type PluginJobValue = Readonly<Record<string, unknown>> & {
  readonly status: "pending" | "done" | "failed";
  readonly progress: number;
};

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
