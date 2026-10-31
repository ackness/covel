/**
 * ToolExecutor — resolves, validates, and executes tool calls from LLM responses.
 *
 * Pipeline per call:
 *   1. Look up tool by name (via the injected findTool callback)
 *   2. Check approval pipeline (if configured)
 *   3. Parse arguments JSON
 *   4. Execute tool.execute(params, context)
 *   5. Record call to DataStore (if available)
 *   6. Return result string for LLM
 */

import {
  isToolError,
  getModelView,
  ToolValidationError,
  getEmittedEvents,
  getPendingProposals,
  getToolContent,
  parseJsonText,
  type EmittedEvent,
  type ToolModule,
  type ToolAnnotations,
  type ToolSource,
} from "@covel/tools";
import type { DataStore } from "@covel/store";
import type { ApprovalPipeline } from "@covel/approval";
import {
  renderToolSuccess,
  renderToolError,
  parseToolResultText,
  type ToolResultError,
} from "./tool-result-text.js";
import type {
  ToolErrorCode,
  ApprovalStatus,
  InputSlot,
  Proposal,
} from "@covel/shared";
import { createToolExecutionContext } from "./tool-execution-context.js";
import {
  createToolExecutorLifetime,
  waitForToolWork,
} from "./tool-executor-lifetime.js";
import { combineAbortSignals } from "../turn-executor/turn-control.js";
import {
  serviceFailureOf,
  ServiceInputValidationError,
  type PluginServiceRegistry,
  type ServiceFailure,
} from "../plugin-services.js";

class ToolTimeoutError extends Error {}

function toolError(
  code: ToolErrorCode,
  message: string,
  hint?: string,
): string {
  return renderToolError({
    code,
    message,
    ...(hint !== undefined ? { hint } : {}),
  });
}

function errorFromText(text: string): ToolResultError {
  return (parseToolResultText(text) as { error: ToolResultError }).error;
}

/** Keep unexpected failures useful without exposing dumps or identifiers. */
function internalMessage(name: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const first = (raw.split(/\r?\n/)[0] ?? "")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "<id>",
    )
    .slice(0, 300);
  return `Tool "${name}" failed: ${first}`;
}

export interface ToolCall {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: string; // JSON string from LLM
}

export interface ToolCallContext {
  readonly delegation?: import("../orchestration/delegation-budget.js").DelegationBudget;
  readonly playerActions?: readonly import("@covel/shared").TurnAction[];
  readonly world?: import("@covel/shared").WorldModelView;
  readonly upstreamProposals?: readonly Proposal[];
  readonly signal?: AbortSignal;
  readonly sessionId: string;
  readonly turnId: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  /** The session's content language, forwarded to the tool context. */
  readonly locale?: string;
  /** The calling plugin's translations, forwarded to the tool context. */
  readonly messages?: import("@covel/shared").PluginMessages;
  readonly inputSlots?: Readonly<Record<string, InputSlot>>;
  readonly pendingProposals?: readonly Proposal[];
  /**
   * Kernel only, never part of the public tool context: upstream writes of
   * the caller's plugin that `context.store` reads include, and the caller's
   * read recorder.
   */
  readonly pluginDataVisibility?: import("../function-runtime/upstream-plugin-data.js").PluginDataVisibility;
  /** Player messages recorded in the session, forwarded to the tool context. */
  readonly turnNumber?: number;
  /** The scheduler's logical turn, forwarded to the tool context. */
  readonly logicalTurn?: number;
  /** Topics already emitted via `emit-event` earlier in this tool loop — see @covel/tools ToolExecutionContext. */
  readonly emittedEventTopics?: readonly string[];
  /** Optional trace emitter — when present, tool.calling / tool.completed / tool.failed are traced. */
  readonly emitter?: import("../trace/turn-emitter.js").TurnEmitter;
  /**
   * The calling runtime's exact tool authorization set (declared whitelist +
   * framework contract tools). When present, `execute` rejects any call whose
   * name is outside the set BEFORE resolution/approval — the advertisement
   * list alone is not an authorization boundary (: a
   * prompt-injected or hook-rewritten name used to reach any builtin, or any
   * local tool of a sibling runtime in the same plugin).
   */
  readonly authorizedToolNames?: ReadonlySet<string>;
  /**
   * Kernel only: the service registry a tool's `context.services` calls
   * through, as the calling plugin and runtime.
   */
  readonly services?: PluginServiceRegistry;
  /**
   * Kernel only: tools the kernel generated for this runtime (imported
   * services), resolved before the registry's tools.
   */
  readonly generatedTools?: ReadonlyMap<string, ToolModule>;
  /**
   * Kernel only: the calling run's operation stage. Each invocation gets a
   * child of it: the write-service operations a tool stages count only when
   * the tool succeeds. Without it, write services answer `unavailable`.
   */
  readonly operations?: import("../operations/operation-stage.js").OperationStage;
}

export interface ToolCallResult {
  readonly toolCallId: string;
  readonly name: string;
  readonly result: string; // JSON string for LLM
  readonly parsedResult: unknown; // Parsed result for framework use
  readonly pendingProposals?: readonly Proposal[];
  /** Domain events emitted via the `emit-event` builtin tool (see @covel/tools result.ts). */
  readonly emittedEvents?: readonly EmittedEvent[];
  readonly success: boolean;
  readonly error?: ToolResultError;
  /**
   * A failed call that the tool refused with `ToolError("refused", …)`: the model had
   * nothing to correct, so the call is not a failure of the runtime.
   */
  readonly refused?: true;
  readonly approvalStatus?: ApprovalStatus;
  /**
   * Kernel only: the provenance of a service failure the call failed with,
   * so a caller that fails because of it blames the provider.
   */
  readonly serviceFailure?: ServiceFailure;
}

export interface ToolInfo {
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly annotations: Readonly<ToolAnnotations>;
  readonly timeoutMs?: number;
}

export interface ToolExecutor {
  execute(call: ToolCall, context: ToolCallContext): Promise<ToolCallResult>;
  /**
   * Look up a tool's model-facing shape and execution metadata.
   *
   * `context` lets the resolver return a session-specific variant — e.g.
   * character write tools with `fields` typed against the
   * active world's CharacterAttributeSchema — and enforces plugin scoping.
   */
  getToolInfo(name: string, context: ToolCallContext): ToolInfo | undefined;
}

export interface ManagedToolExecutor extends ToolExecutor {
  /** Stop admission, cancel callers, and drain callbacks before closing their dependencies. */
  close(): Promise<void>;
}

// ── Implementation ───────────────────────────────────────────────

export interface ToolExecutorConfig {
  /** Tool lookup function — returns the tool module by name. Context enables per-plugin scoping. */
  readonly findTool?: (
    name: string,
    context: ToolCallContext,
  ) => ToolModule | undefined;
  /** Optional DataStore for scoped tool reads and recording tool calls. */
  readonly store?: DataStore;
  /** Optional approval pipeline for permission checking. */
  readonly approval?: ApprovalPipeline;
  /** Optional function to determine tool source category. */
  readonly getToolSource?: (toolName: string) => ToolSource;
}

function toolLabel(pluginId: string, toolName: string): string {
  return `${pluginId}/${toolName}`;
}

/**
 * Emit a tool trace event (`tool.calling` / `tool.completed` / `tool.failed`).
 *
 * No-op when no emitter is configured. The shared identity envelope
 * (runtimeId / pluginId / toolName / toolCallId / label / approvalStatus) is
 * always present; event-specific fields are merged from `extra`. This single
 * helper replaces the three near-identical `emitToolCalling/Completed/Failed`
 * functions that all unpacked the same context.
 */
async function emitToolEvent(
  ctx: ToolCallContext,
  call: ToolCall,
  eventType: "tool.calling" | "tool.completed" | "tool.failed",
  approvalStatus: ApprovalStatus,
  extra: Record<string, unknown>,
): Promise<void> {
  if (!ctx.emitter) return;
  try {
    await ctx.emitter.emit(eventType, {
      runtimeId: ctx.runtimeId,
      pluginId: ctx.pluginId,
      toolName: call.name,
      toolCallId: call.toolCallId,
      label: toolLabel(ctx.pluginId, call.name),
      approvalStatus,
      ...extra,
    });
  } catch (error) {
    console.warn(
      `[ToolExecutor] Failed to emit ${eventType} for ${call.name}:`,
      error,
    );
  }
}

function emitToolCalling(
  ctx: ToolCallContext,
  call: ToolCall,
  source: ToolSource,
  approvalStatus: ApprovalStatus,
): Promise<void> {
  return emitToolEvent(ctx, call, "tool.calling", approvalStatus, {
    arguments: call.arguments,
    source,
  });
}

function emitToolCompleted(
  ctx: ToolCallContext,
  call: ToolCall,
  result: string,
  parsedResult: unknown,
  durationMs: number,
  approvalStatus: ApprovalStatus,
): Promise<void> {
  return emitToolEvent(ctx, call, "tool.completed", approvalStatus, {
    result,
    parsedResult,
    durationMs,
    success: true,
  });
}

function emitToolFailed(
  ctx: ToolCallContext,
  call: ToolCall,
  code: ToolErrorCode,
  error: string,
  details: string[] | undefined,
  durationMs: number,
  approvalStatus: ApprovalStatus,
  hint?: string,
): Promise<void> {
  return emitToolEvent(ctx, call, "tool.failed", approvalStatus, {
    code,
    error,
    ...(hint !== undefined ? { hint } : {}),
    ...(details && details.length > 0 ? { details } : {}),
    durationMs,
    success: false,
  });
}

function resolveToolModule(
  config: ToolExecutorConfig,
  name: string,
  context: ToolCallContext,
): ToolModule | undefined {
  return context.generatedTools?.get(name) ?? config.findTool?.(name, context);
}

/**
 * The answer to a call that failed because a service it called failed. Only
 * a bad input is the model's to fix; the other failures are the provider's,
 * so the call is refused rather than failed. Messages name the tool only:
 * provider errors can carry plugin IDs.
 */
function serviceFailureAnswer(
  name: string,
  error: unknown,
  failure: ServiceFailure,
): { code: ToolErrorCode; message: string; hint?: string; refused: boolean } {
  switch (failure.errorCode) {
    case "unavailable":
    case "admission-error":
    case "cycle-or-depth-limit":
      return {
        code: "unavailable",
        message:
          isToolError(error) && error.code === "unavailable"
            ? error.message
            : `The tool "${name}" is unavailable: the service it calls is not available in this session.`,
        refused: true,
      };
    case "timeout":
      return {
        code: "timeout",
        message: `The tool "${name}" timed out waiting for its service.`,
        refused: true,
      };
    case "cancelled":
      return {
        code: "cancelled",
        message: "Tool execution was cancelled",
        refused: false,
      };
    case "input-validation": {
      const details =
        error instanceof ServiceInputValidationError
          ? [...new Set(error.details)].slice(0, 5)
          : [];
      return {
        code: "invalid-input",
        message: `Invalid parameters for tool "${name}"${details.length ? `: ${details.join("; ")}` : ""}. Fix the input and retry.`,
        hint: "Fix these fields and call the tool again.",
        refused: false,
      };
    }
    case "output-validation":
      return {
        code: "internal",
        message: "The service returned an invalid result.",
        refused: true,
      };
    case "invocation-error":
      return isToolError(error)
        ? {
            code: error.code,
            message: error.message,
            ...(error.hint !== undefined ? { hint: error.hint } : {}),
            refused:
              error.code !== "invalid-input" && error.code !== "cancelled",
          }
        : {
            code: "internal",
            message: internalMessage(name, error),
            refused: true,
          };
    case "invalid-options":
      // The calling tool passed bad options: its own mistake.
      return {
        code: "internal",
        message: internalMessage(name, error),
        refused: false,
      };
  }
}

export function createToolExecutor(
  config: ToolExecutorConfig,
): ManagedToolExecutor {
  const lifetime = createToolExecutorLifetime();
  const executor: ToolExecutor = {
    getToolInfo(name: string, context: ToolCallContext): ToolInfo | undefined {
      const tool = resolveToolModule(config, name, context);
      if (!tool) return undefined;
      return {
        name: tool.name,
        description: tool.description,
        jsonSchema: tool.jsonSchema as Record<string, unknown>,
        annotations: tool.annotations,
        ...(tool.timeoutMs !== undefined ? { timeoutMs: tool.timeoutMs } : {}),
      };
    },

    async execute(
      call: ToolCall,
      context: ToolCallContext,
    ): Promise<ToolCallResult> {
      const startTime = Date.now();
      context.signal?.throwIfAborted();

      // 0. Runtime-level authorization. Enforced at the execution
      // boundary — after session overrides and PreToolUse replacement have
      // already produced the final name — so a rewritten or hallucinated
      // name cannot escape the calling runtime's declared surface.
      if (
        context.authorizedToolNames &&
        !context.authorizedToolNames.has(call.name)
      ) {
        const errorResult = toolError(
          "unavailable",
          `Tool "${call.name}" is not declared by runtime "${context.runtimeId}". Only declared tools may be called.`,
        );
        await recordCall(
          config.store,
          call,
          context,
          errorResult,
          startTime,
          false,
          "auto-allowed",
        );
        await emitToolFailed(
          context,
          call,
          "unavailable",
          `tool not declared by runtime ${context.runtimeId}`,
          undefined,
          Date.now() - startTime,
          "auto-allowed",
        );
        return {
          toolCallId: call.toolCallId,
          name: call.name,
          result: errorResult,
          error: errorFromText(errorResult),
          parsedResult: null,
          success: false,
          approvalStatus: "auto-allowed" as const,
        };
      }

      // 1. Resolve tool module (scoped to calling plugin if context available)
      const tool = resolveToolModule(config, call.name, context);
      if (!tool) {
        const errorResult = toolError(
          "not-found",
          `Unknown tool: ${call.name}. Check the tool name and try again.`,
        );
        await recordCall(
          config.store,
          call,
          context,
          errorResult,
          startTime,
          false,
          "auto-allowed",
        );
        await emitToolFailed(
          context,
          call,
          "not-found",
          `Unknown tool: ${call.name}`,
          undefined,
          Date.now() - startTime,
          "auto-allowed",
        );
        return {
          toolCallId: call.toolCallId,
          name: call.name,
          result: errorResult,
          error: errorFromText(errorResult),
          parsedResult: null,
          success: false,
          approvalStatus: "auto-allowed" as const,
        };
      }

      // 2. Check approval
      let approvalStatus: ApprovalStatus = "auto-allowed";
      const toolSource = config.getToolSource?.(call.name) ?? "local";

      if (config.approval) {
        const checkResult = config.approval.check(
          {
            toolName: call.name,
            pluginId: context.pluginId,
            runtimeId: context.runtimeId,
            input: tryParseJson(call.arguments),
            turnId: context.turnId,
            sessionId: context.sessionId,
          },
          toolSource,
        );

        if (checkResult.decision === "deny") {
          approvalStatus = "policy-denied";
          const denyResult = toolError(
            "refused",
            `Tool "${call.name}" was denied by the approval policy. Reason: ${checkResult.reason}.`,
            "Do not retry this call.",
          );
          await recordCall(
            config.store,
            call,
            context,
            denyResult,
            startTime,
            false,
            approvalStatus,
          );
          await emitToolFailed(
            context,
            call,
            "refused",
            checkResult.reason ?? "denied by approval policy",
            undefined,
            Date.now() - startTime,
            approvalStatus,
            "Do not retry this call.",
          );
          return {
            toolCallId: call.toolCallId,
            name: call.name,
            result: denyResult,
            error: errorFromText(denyResult),
            parsedResult: null,
            success: false,
            approvalStatus,
          };
        }
      }

      // 3. Parse arguments. The slips `parseJsonText` settles do not fail
      // the call; any other fault goes back to the model.
      let params: unknown;
      try {
        params = parseJsonText(call.arguments);
      } catch {
        const errorResult = toolError(
          "invalid-input",
          `Arguments for tool "${call.name}" are not valid JSON. Ensure the arguments object is properly formatted JSON.`,
          "Send the arguments as one JSON object.",
        );
        await recordCall(
          config.store,
          call,
          context,
          errorResult,
          startTime,
          false,
          approvalStatus,
        );
        await emitToolFailed(
          context,
          call,
          "invalid-input",
          "arguments are not valid JSON",
          undefined,
          Date.now() - startTime,
          approvalStatus,
          "Send the arguments as one JSON object.",
        );
        return {
          toolCallId: call.toolCallId,
          name: call.name,
          result: errorResult,
          error: errorFromText(errorResult),
          parsedResult: null,
          success: false,
          approvalStatus,
        };
      }

      // 4. Execute
      let invocation: ReturnType<typeof createToolExecutionContext> | undefined;
      // The operations this invocation stages through write services; kept
      // only when the call succeeds.
      const operations = context.operations?.child();
      let operationsKept = false;
      try {
        const timeoutController =
          tool.timeoutMs !== undefined ? new AbortController() : undefined;
        const executionSignal = combineAbortSignals(
          context.signal,
          timeoutController?.signal,
        );
        invocation = createToolExecutionContext(
          {
            ...context,
            signal: executionSignal,
            ...(operations ? { operations } : {}),
          },
          config.store,
          call.toolCallId,
        );
        // Capture authority before any asynchronous trace work.
        await emitToolCalling(context, call, toolSource, approvalStatus);
        invocation.assertLive();
        const active = invocation;
        const { parsedResult, pendingProposals, emittedEvents, model } =
          await (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              if (timeoutController && tool.timeoutMs !== undefined) {
                timer = setTimeout(
                  () =>
                    timeoutController.abort(
                      new ToolTimeoutError(
                        `Tool "${call.name}" timed out after ${tool.timeoutMs}ms`,
                      ),
                    ),
                  tool.timeoutMs,
                );
                timer.unref?.();
              }
              const work = lifetime.track(
                (async () => {
                  try {
                    const rawResult = await tool.execute(
                      params,
                      active.context,
                    );
                    active.assertLive();
                    // Snapshot envelopes before cleanup or trace persistence can yield.
                    return {
                      model: structuredClone(getModelView(rawResult)),
                      parsedResult: structuredClone(getToolContent(rawResult)),
                      pendingProposals: structuredClone(
                        getPendingProposals(rawResult),
                      ),
                      emittedEvents: structuredClone(
                        getEmittedEvents(rawResult),
                      ),
                    };
                  } finally {
                    active.close();
                    await active.drain();
                  }
                })(),
              );
              return await waitForToolWork(work, executionSignal!, () =>
                active.close(),
              );
            } finally {
              if (timer !== undefined) clearTimeout(timer);
            }
          })();
        context.signal?.throwIfAborted();
        const stagedOperations = operations?.held() ?? [];
        if (
          tool.annotations.readOnly &&
          ((pendingProposals?.length ?? 0) > 0 ||
            (emittedEvents?.length ?? 0) > 0 ||
            stagedOperations.length > 0)
        )
          throw new Error("read-only tool returned writes");

        const resultStr = renderToolSuccess({
          content: parsedResult,
          model,
          pendingProposals,
          emittedEvents,
          ...(stagedOperations.length > 0
            ? {
                stagedOperations: {
                  count: stagedOperations.length,
                  kinds: [
                    ...new Set(
                      stagedOperations.flatMap((operation) =>
                        operation.writes.map((write) => write.type),
                      ),
                    ),
                  ],
                },
              }
            : {}),
          locale: context.locale,
        });

        // Accept the snapshotted result before recording its terminal state.
        // Cancellation after this point still aborts the enclosing runtime,
        // but cannot turn this accepted call into a second, failed record.
        context.signal?.throwIfAborted();
        operations?.commit();
        operationsKept = true;
        const durationMs = Date.now() - startTime;
        await recordCall(
          config.store,
          call,
          context,
          resultStr,
          startTime,
          true,
          approvalStatus,
        );
        await emitToolCompleted(
          context,
          call,
          resultStr,
          parsedResult,
          durationMs,
          approvalStatus,
        );
        if (context.emitter && emittedEvents && emittedEvents.length > 0) {
          for (const event of emittedEvents) {
            try {
              await context.emitter.emit("domain-event.previewed", {
                runtimeId: context.runtimeId,
                pluginId: context.pluginId,
                toolCallId: call.toolCallId,
                topic: event.topic,
                data: event.data,
              });
            } catch (error) {
              console.warn(
                `[ToolExecutor] Failed to preview event ${event.topic}:`,
                error,
              );
            }
          }
        }
        return {
          toolCallId: call.toolCallId,
          name: call.name,
          result: resultStr,
          parsedResult,
          pendingProposals,
          emittedEvents,
          success: true,
          approvalStatus,
        };
      } catch (error: unknown) {
        invocation?.close();
        // The tracked callback owns its outstanding reads after cancellation.
        // Waiting here would wedge the caller behind an uncooperative tool.
        let errorResult: string;
        let code: ToolErrorCode;
        let details: string[] | undefined;
        let message: string;
        let hint: string | undefined;
        let refused = false;
        // Set only for a failure the provider owns, never the caller's own.
        let providerFailure: ServiceFailure | undefined;
        const serviceFailure = serviceFailureOf(error);
        if (context.signal?.aborted) {
          code = "cancelled";
          message = "Tool execution was cancelled";
          errorResult = toolError(code, message);
        } else if (error instanceof ToolTimeoutError) {
          code = "timeout";
          message = error.message;
          errorResult = toolError(code, message);
        } else if (serviceFailure) {
          const answer = serviceFailureAnswer(call.name, error, serviceFailure);
          ({ code, message, hint, refused } = answer);
          if (refused) providerFailure = serviceFailure;
          errorResult = toolError(code, message.slice(0, 2000), hint);
          if (code === "internal")
            console.warn(
              `[ToolExecutor] Service called by tool "${call.name}" failed:`,
              error,
            );
        } else if (error instanceof ToolValidationError) {
          // Dedupe Zod issues by path so only the FIRST issue on any given
          // field is reported. Zod v4 has a quirk where `z.array(...).max(N)`
          // will emit a bogus `too_big: expected string to have <=N characters`
          // alongside the real `invalid_type: expected array, received string`
          // when the LLM sends a JSON-stringified array. Feeding both to the
          // LLM confuses it into fixing a phantom "string length" problem
          // while the real fix ("send an array") is buried. Keeping only the
          // first issue per path eliminates the contradiction without losing
          // information — multi-field errors still list each field once.
          const seenPaths = new Set<string>();
          const dedupedDetails: typeof error.details = [];
          for (const detail of error.details) {
            const key = detail.path ?? "";
            if (seenPaths.has(key)) continue;
            seenPaths.add(key);
            dedupedDetails.push(detail);
          }
          details = dedupedDetails.map((d) => `${d.path}: ${d.message}`);
          // Name each field in the headline too: "expected array, received
          // undefined" alone does not say which one, and a model sent the
          // same incomplete call again.
          message = details.join("; ");
          code = "invalid-input";
          errorResult = toolError(
            code,
            `Invalid parameters for tool "${call.name}": ${message}. Fix the highlighted fields and retry.`,
            "Fix these fields and call the tool again.",
          );
          hint = "Fix these fields and call the tool again.";
        } else if (isToolError(error)) {
          code = error.code;
          message = error.message;
          hint = error.hint;
          errorResult = toolError(code, message.slice(0, 2000), hint);
        } else {
          message = error instanceof Error ? error.message : String(error);
          code = "internal";
          errorResult = toolError(code, internalMessage(call.name, error));
          console.warn(`[ToolExecutor] Tool "${call.name}" failed:`, error);
        }
        await recordCall(
          config.store,
          call,
          context,
          errorResult,
          startTime,
          false,
          approvalStatus,
        );
        await emitToolFailed(
          context,
          call,
          code,
          message,
          details,
          Date.now() - startTime,
          approvalStatus,
          hint,
        );
        return {
          toolCallId: call.toolCallId,
          name: call.name,
          result: errorResult,
          error: errorFromText(errorResult),
          parsedResult: null,
          success: false,
          ...(refused ||
          (isToolError(error) && error.code === "refused" && code === "refused")
            ? { refused: true as const }
            : {}),
          approvalStatus,
          ...(providerFailure ? { serviceFailure: providerFailure } : {}),
        };
      } finally {
        invocation?.close();
        if (!operationsKept) operations?.discard();
      }
    },
  };
  return {
    getToolInfo(name, context) {
      lifetime.assertOpen();
      return executor.getToolInfo(name, context);
    },
    execute(call, context) {
      try {
        lifetime.assertOpen();
      } catch (error) {
        return Promise.reject(error);
      }
      return lifetime.track(
        executor.execute(call, {
          ...context,
          signal: combineAbortSignals(context.signal, lifetime.signal),
        }),
      );
    },
    close: () => lifetime.close(),
  };
}

/** The arguments the approval check sees: the same parse the call then runs on. */
function tryParseJson(json: string): Record<string, unknown> {
  try {
    return parseJsonText(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function recordCall(
  store: DataStore | undefined,
  call: ToolCall,
  context: ToolCallContext,
  result: string,
  startTime: number,
  success: boolean,
  approvalStatus: string,
): Promise<void> {
  if (!store) return;
  try {
    await store.saveToolCall({
      id: crypto.randomUUID(),
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolName: call.name,
      pluginId: context.pluginId,
      runtimeId: context.runtimeId,
      input: call.arguments,
      output: result,
      durationMs: Date.now() - startTime,
      approvalStatus,
      createdAt: new Date().toISOString(),
    });
  } catch (recordErr) {
    console.warn(
      `[ToolExecutor] Failed to record tool call for ${call.name}:`,
      recordErr,
    );
  }
}
