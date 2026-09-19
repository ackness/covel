import type { FunctionHandlerContext } from "@covel/shared/plugin-runtime";
import {
  toJsonValueOrDiagnostic,
  type InputSlot,
  type RuntimeManifest,
  type ToolCallRecord,
} from "@covel/shared";
import type { EmittedEvent } from "@covel/tools";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";
import { declaredToolNames } from "../agent-loop/tool-search.js";
import {
  runPostToolUseHook,
  runPreToolUseHook,
} from "../hooks/wire-helpers.js";
import type { ExecutionWriteBuffer } from "./execution-write-buffer.js";
import type { HandlerHelperContext } from "./plugin-handler-helpers.js";

/** Deterministic handlers use the same governed tools as agent runtimes. */
export function createRuntimeTools(options: {
  manifest: RuntimeManifest;
  context: HandlerHelperContext;
  deps: TurnExecutorDeps;
  buffer: ExecutionWriteBuffer;
  inputs?: Readonly<Record<string, InputSlot>>;
  signal: AbortSignal;
  assertLive: () => void;
}) {
  const { manifest, context, deps, buffer, signal, assertLive } = options;
  const authorizedToolNames = new Set(declaredToolNames(manifest));
  const records: ToolCallRecord[] = [];
  const events: EmittedEvent[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  let failure: unknown;
  let failed = false;
  let terminated = false;
  const hookOptions = {
    ...context,
    pipeline: deps.hookPipeline,
    eventBus: deps.eventBus,
    emitter: deps.emitter,
    signal,
  };
  const tools: NonNullable<FunctionHandlerContext["tools"]> = {
    call(name, args) {
      assertLive();
      let argumentsJson: string;
      try {
        argumentsJson = JSON.stringify(args);
      } catch (error) {
        failure = error;
        failed = true;
        return Promise.reject(error);
      }
      // Serialize calls so tools see earlier buffered writes even with Promise.all.
      const pending = tail.then(async () => {
        assertLive();
        signal.throwIfAborted();
        if (terminated)
          throw new Error("Tool calls were terminated by PostToolUse");
        if (failed) throw failure;
        if (!deps.toolExecutor) throw new Error("Tool executor is unavailable");
        const started = Date.now();
        const before = await runPreToolUseHook(hookOptions, {
          id: crypto.randomUUID(),
          name,
          arguments: argumentsJson,
        });
        assertLive();
        if (before.skipped) throw new Error(before.reason);
        const call = before.toolCall;
        const raw = await deps.toolExecutor.execute(
          { toolCallId: call.id, name: call.name, arguments: call.arguments },
          {
            ...context,
            signal,
            authorizedToolNames,
            pendingProposals: buffer,
            inputSlots: options.inputs,
            emittedEventTopics: events.map((event) => event.topic),
            emitter: deps.emitter,
          },
        );
        assertLive();
        const { result, terminate } = await runPostToolUseHook(
          hookOptions,
          call,
          raw,
        );
        terminated = terminate;
        assertLive();
        records.push({
          toolCallId: call.id,
          toolName: call.name,
          pluginId: context.pluginId,
          runtimeId: context.runtimeId,
          turnId: context.turnId,
          input: toJsonValueOrDiagnostic(JSON.parse(call.arguments), "input"),
          output: toJsonValueOrDiagnostic(result.parsedResult, "output"),
          durationMs: Date.now() - started,
          approvalStatus: result.approvalStatus ?? "auto-allowed",
          timestamp: new Date().toISOString(),
        });
        if (!result.success) throw new Error(result.result);
        buffer.push(...(result.pendingProposals ?? []));
        events.push(...(result.emittedEvents ?? []));
        return result.parsedResult;
      });
      tail = pending.catch((error: unknown) => {
        failure = error;
        failed = true;
      });
      return pending;
    },
  };
  return {
    tools,
    records,
    events,
    async drain() {
      while (true) {
        const current = tail;
        await current;
        if (current === tail) break;
      }
      // A failed command fails the transaction even if plugin code swallowed it.
      if (failed) throw failure;
    },
  };
}
