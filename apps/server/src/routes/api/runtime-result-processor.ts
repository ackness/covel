import type { EventBus } from "@covel/events";
import type { RuntimeManifest, RuntimeResult } from "@covel/shared";
import {
  processRuntimeResult,
  type HookPipeline,
  type KernelStore,
  type ProcessRuntimeResultOutput,
  type TurnEmitter,
} from "@covel/runtime";

type RuntimeResultManifest = Pick<
  RuntimeManifest,
  "name" | "outputKind" | "capabilities"
>;

export interface RuntimeResultProcessorOptions {
  readonly store: KernelStore;
  readonly sessionId: string;
  readonly runtimes: readonly RuntimeResultManifest[];
  readonly hookPipeline?: HookPipeline;
  readonly eventBus?: EventBus;
  readonly emitter?: TurnEmitter;
}

export interface RuntimeResultProcessor {
  getOutputKind(runtimeId: string): string;
  getCapabilities(runtimeId: string): readonly string[];
  process(result: RuntimeResult): Promise<ProcessRuntimeResultOutput>;
  processAll(
    results: readonly RuntimeResult[],
  ): Promise<readonly ProcessRuntimeResultOutput[]>;
}

export function createRuntimeResultProcessor(
  options: RuntimeResultProcessorOptions,
): RuntimeResultProcessor {
  const outputKindByRuntime = new Map<string, string>();
  const capabilitiesByRuntime = new Map<string, readonly string[]>();

  for (const rt of options.runtimes) {
    outputKindByRuntime.set(rt.name, rt.outputKind ?? "plugin");
    capabilitiesByRuntime.set(rt.name, rt.capabilities ?? []);
  }

  const getOutputKind = (runtimeId: string): string =>
    outputKindByRuntime.get(runtimeId) ?? "plugin";

  const getCapabilities = (runtimeId: string): readonly string[] =>
    capabilitiesByRuntime.get(runtimeId) ?? [];

  const process = (
    result: RuntimeResult,
  ): Promise<ProcessRuntimeResultOutput> =>
    processRuntimeResult(
      result,
      options.store,
      options.sessionId,
      getOutputKind(result.runtimeId),
      {
        ...(options.hookPipeline ? { hookPipeline: options.hookPipeline } : {}),
        ...(options.eventBus ? { eventBus: options.eventBus } : {}),
        ...(options.emitter ? { emitter: options.emitter } : {}),
        capabilities: getCapabilities(result.runtimeId),
      },
    );

  return {
    getOutputKind,
    getCapabilities,
    process,
    async processAll(results) {
      const outputs: ProcessRuntimeResultOutput[] = [];
      for (const result of results) {
        outputs.push(await process(result));
      }
      return outputs;
    },
  };
}
