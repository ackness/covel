import type { FunctionHandlerContext } from "@covel/shared/plugin-runtime";
import {
  ToolError,
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
import type { PluginDataVisibility } from "./upstream-plugin-data.js";
import { tagServiceFailure } from "../plugin-services.js";
import type { OperationStage } from "../operations/operation-stage.js";

/** A hook may rewrite the arguments into text that is not JSON. */
function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Deterministic handlers use the same governed tools as agent runtimes. */
export function createRuntimeTools(options: {
  world?: import("@covel/shared").WorldModelView;
  /** The execution's frozen logical turn, when supplied by the host. */
  logicalTurn?: number;
  upstreamProposals?: readonly import("@covel/shared").Proposal[];
  manifest: RuntimeManifest;
  context: HandlerHelperContext;
  /** The session's content language, forwarded to each tool call. */
  locale?: string;
  /** The plugin's translations for that language, forwarded as well. */
  messages?: import("@covel/shared").PluginMessages;
  deps: TurnExecutorDeps;
  buffer: ExecutionWriteBuffer;
  /** Upstream writes of the same plugin and the invocation's read recorder. */
  pluginDataVisibility?: PluginDataVisibility;
  inputs?: Readonly<Record<string, InputSlot>>;
  signal: AbortSignal;
  assertLive: () => void;
  /** The run's operation stage, for tools that call write services. */
  operations?: OperationStage;
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
        // `JSON.stringify` yields `undefined` for a non-serializable root.
        const serialized: string | undefined = JSON.stringify(args);
        if (serialized === undefined)
          throw new TypeError("the value has no JSON form");
        argumentsJson = serialized;
      } catch (error) {
        const rejection = new ToolError(
          "invalid-input",
          `Tool arguments must be JSON-serializable: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { hint: "Pass plain JSON values as the tool arguments." },
        );
        failure = rejection;
        failed = true;
        return Promise.reject(rejection);
      }
      // Serialize calls so tools see earlier buffered writes even with Promise.all.
      const pending = tail.then(async () => {
        assertLive();
        signal.throwIfAborted();
        if (terminated)
          throw new ToolError(
            "cancelled",
            "Tool calls were terminated by PostToolUse",
          );
        if (failed) throw failure;
        if (!deps.toolExecutor)
          throw new ToolError("unavailable", "Tool executor is unavailable");
        const started = Date.now();
        const before = await runPreToolUseHook(hookOptions, {
          id: crypto.randomUUID(),
          name,
          arguments: argumentsJson,
        });
        assertLive();
        if (before.skipped)
          throw new ToolError(
            "refused",
            before.reason ?? "Tool call was blocked by PreToolUse",
          );
        const call = before.toolCall;
        const raw = await deps.toolExecutor.execute(
          { toolCallId: call.id, name: call.name, arguments: call.arguments },
          {
            ...context,
            ...(options.logicalTurn !== undefined
              ? { logicalTurn: options.logicalTurn }
              : {}),
            locale: options.locale,
            messages: options.messages,
            signal,
            authorizedToolNames,
            pendingProposals: buffer,
            ...(options.pluginDataVisibility
              ? { pluginDataVisibility: options.pluginDataVisibility }
              : {}),
            upstreamProposals: options.upstreamProposals,
            world: options.world,
            inputSlots: options.inputs,
            emittedEventTopics: events.map((event) => event.topic),
            emitter: deps.emitter,
            ...(deps.services ? { services: deps.services } : {}),
            ...(options.operations ? { operations: options.operations } : {}),
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
          input: toJsonValueOrDiagnostic(
            parseArguments(call.arguments),
            "input",
          ),
          output: toJsonValueOrDiagnostic(result.parsedResult, "output"),
          durationMs: Date.now() - started,
          approvalStatus: result.approvalStatus ?? "auto-allowed",
          timestamp: new Date().toISOString(),
        });
        if (!result.success) {
          const error = result.error;
          if (!error)
            throw new ToolError(
              "internal",
              "Tool call failed without an error.",
            );
          const rejection = new ToolError(error.code, error.message, {
            hint: error.hint,
          });
          // A tool that failed because its service failed blames the
          // provider, as a direct service failure of the handler would.
          throw raw.serviceFailure
            ? tagServiceFailure(rejection, raw.serviceFailure)
            : rejection;
        }
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
