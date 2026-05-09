import type {
  Proposal,
  RuntimeManifest,
  RuntimeResult,
  ToolCallRecord,
  TurnInput,
} from "@covel/shared";
import { isEnvEnabled } from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import type { SuspensionRecord } from "@covel/store";
import { isSuspendSentinel, isRuntimeDoneSentinel } from "@covel/tools";
import type { LLMMessage } from "./llm-adapter.js";
import type { HookPipeline } from "./hooks/pipeline.js";
import { buildToolDefinitions } from "./turn-executor-helpers.js";
import {
  buildRetryPolicy,
  callLLMWithRetry,
  streamLLMWithRetry,
  detectToolLoop,
  perturbMessages,
  LLMRetryError,
  type RetryInfo,
} from "./llm-retry.js";
import {
  buildLlmCallingPayload,
  buildLlmRespondedErrorPayload,
  buildLlmRespondedSuccessPayload,
} from "./llm-trace-payload.js";
import {
  runPostRuntimeHook,
  runPreToolUseHook,
  runPostToolUseHook,
} from "./hooks/wire-helpers.js";
import { emitSubEvent } from "./turn-runtime-helpers.js";
import {
  extractToolFailureMessage,
  shouldRetryMalformedToolArguments,
  type ExecutedToolCallState,
  type FailedToolCallState,
} from "./turn-output-helpers.js";
import type { TurnExecutorDeps } from "./turn-executor-types.js";

export interface AgentToolLoopCompleted {
  readonly finalContent: string | null;
  readonly collectedToolCalls: ToolCallRecord[];
  readonly executedToolCalls: ExecutedToolCallState[];
  readonly failedToolCalls: FailedToolCallState[];
  readonly pendingProposals: Proposal[];
  readonly streamDeltaCount: number;
  readonly stoppedWithResponse: boolean;
  readonly effectiveMaxSteps: number;
  readonly deadline: number;
}

export type AgentToolLoopResult = AgentToolLoopCompleted | RuntimeResult;

export interface RunAgentToolLoopOptions {
  readonly manifest: RuntimeManifest;
  readonly input: TurnInput;
  readonly loaded: LoadedRuntime;
  readonly deps: TurnExecutorDeps;
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly messages: LLMMessage[];
  readonly hookPipeline: HookPipeline | undefined;
  readonly startTime: number;
  readonly runId: string;
}

export async function runAgentToolLoop({
  manifest,
  input,
  loaded,
  deps,
  maxSteps,
  timeoutMs,
  messages,
  hookPipeline,
  startTime,
  runId,
}: RunAgentToolLoopOptions): Promise<AgentToolLoopResult> {
  // LLM call with tool-calling loop
  let finalContent: string | null = null;
  const collectedToolCalls: ToolCallRecord[] = [];
  const executedToolCalls: ExecutedToolCallState[] = [];
  const failedToolCalls: FailedToolCallState[] = [];
  const pendingProposals: Proposal[] = [];
  let steps = 0;
  // Count streaming text deltas so the `message.completed` trace event can
  // report how many chunks the narrative was assembled from. Non-streaming
  // runtimes keep this at 0; trace consumers treat that as "not streamed".
  let streamDeltaCount = 0;

  const deadline = Date.now() + timeoutMs;
  let stoppedWithResponse = false;

  // Build tool definitions from manifest declarations (computed once, reused across steps).
  // The ToolCallContext is also passed so the executor can surface session-
  // specific variants (e.g. character tools with schema-typed `fields`).
  const toolContext = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
  } as const;
  const toolDefs = deps.toolExecutor
    ? buildToolDefinitions(manifest, deps.toolExecutor, toolContext)
    : undefined;
  const responseFormat = loaded.outputSchema
    ? { type: "json_schema" as const, schema: loaded.outputSchema }
    : undefined;
  // PR-6: per-session per-runtime slot override snapshot. Applies to all
  // runtime kinds (story + plugin), unlike the legacy story-only API
  // override below.
  const sessionRuntimeSlot = input.runtimeModelOverrides?.[manifest.name];
  const runtimeModelOverride =
    input.modelOverride && manifest.outputKind === "story"
      ? input.modelOverride
      : sessionRuntimeSlot;

  // Stream only for story-output runtimes. Plugin runtimes' raw LLM text is
  // reasoning chatter that feeds into structured tool calls — it should never
  // reach the user's narrative feed. Story runtimes that also declare tools
  // (e.g. narrator + world-dimension-get) still stream: tool_call deltas are
  // accumulated from the stream alongside text deltas, and if the provider
  // cannot parse tool calls from stream chunks the loop falls back to
  // generate() when finishReason === 'tool_calls' with an empty accumulator.
  const useStreaming = !!(
    deps.onDelta &&
    deps.llm.stream &&
    manifest.outputKind === "story"
  );

  // Per-runtime maxSteps override. Plugins that should call a tool once and
  // stop (e.g. guide) set `maxSteps: 2` in their frontmatter to prevent
  // the LLM from running the same tool in a loop after it already succeeds.
  const effectiveMaxSteps = manifest.maxSteps ?? maxSteps;

  // Smart retry policy derived from manifest (maxRetries / callTimeoutMs /
  // firstTokenTimeoutMs / loopDetectionThreshold). A hung provider call now
  // fails fast inside the helper's per-attempt budget and retries with a
  // perturbation instead of burning the whole runtime timeout.
  const retryPolicy = buildRetryPolicy({
    maxRetries: manifest.maxRetries,
    callTimeoutMs: manifest.callTimeoutMs,
    firstTokenTimeoutMs: manifest.firstTokenTimeoutMs,
    loopDetectionThreshold: manifest.loopDetectionThreshold,
    runtimeTimeoutMs: timeoutMs,
  });
  const reportRetry = (info: RetryInfo): void => {
    const cause =
      info.error instanceof Error ? info.error.message : String(info.error);
    console.warn(
      `[runtime-retry] ${manifest.name} attempt=${info.attempt} reason=${info.reason} cause=${cause.slice(0, 200)}`,
    );
  };

  // Count how many times we injected a perturbation into `messages` due to
  // tool-loop detection. Once a loop has been perturbed and reappears, we
  // give up — another perturbation would not help.
  let loopPerturbations = 0;

  while (steps < effectiveMaxSteps && Date.now() < deadline) {
    steps++;

    // Model resolution chain for story runtimes:
    // API override > plugin llm.toml > manifest.model > undefined.
    // Tool-heavy plugin runtimes stay on their declared slot so E2E story
    // overrides do not destabilize function-calling behaviour.
    const effectiveModel = deps.resolveModel
      ? deps.resolveModel(manifest, runtimeModelOverride)
      : (runtimeModelOverride ?? manifest.model);

    let response: import("./llm-adapter.js").LLMResponse;

    if (useStreaming) {
      // Streaming path: helper enforces per-attempt call-timeout + first-
      // token (TTFB) guard, retries on transient failures, and forwards
      // text deltas to the caller on the first attempt (avoids duplicate
      // text in the chat stream when a retry happens). If streaming
      // exhausts its retries with a transient failure (e.g. provider SSE
      // never recovered), fall back to a single non-stream call — matches
      // the pre-helper behaviour for providers whose streaming path is
      // more fragile than their JSON completion endpoint.
      try {
        const streamed = await streamLLMWithRetry({
          llm: deps.llm,
          model: effectiveModel,
          messages,
          tools: toolDefs,
          responseFormat,
          policy: retryPolicy,
          deadline,
          onDelta: async (textDelta) => {
            streamDeltaCount++;
            try {
              await deps.onDelta!({
                runtimeId: manifest.name,
                pluginId: manifest.pluginId,
                textDelta,
              });
            } catch {
              // Client disconnected — keep streaming to capture full content.
            }
          },
          onRetry: reportRetry,
          emitter: deps.emitter,
          runtimeId: manifest.name,
          pluginId: manifest.pluginId,
        });
        response = streamed.response;
      } catch (streamError) {
        if (streamError instanceof LLMRetryError && Date.now() < deadline) {
          console.warn(
            `[stream-recovery] ${manifest.name} streaming exhausted (reason=${streamError.reason}); falling back to non-stream generate()`,
          );
          response = await callLLMWithRetry({
            llm: deps.llm,
            model: effectiveModel,
            messages,
            tools: toolDefs,
            responseFormat,
            policy: retryPolicy,
            deadline,
            onRetry: reportRetry,
            emitter: deps.emitter,
            runtimeId: manifest.name,
            pluginId: manifest.pluginId,
          });
        } else {
          throw streamError;
        }
      }

      // If the stream finished with tool_calls but our adapter could not
      // parse structured calls out of delta chunks (some providers don't
      // deliver them on SSE), fall back to a non-stream call to get the
      // structured tool_calls payload.
      if (
        response.finishReason === "tool_calls" &&
        response.toolCalls.length === 0 &&
        toolDefs
      ) {
        response = await callLLMWithRetry({
          llm: deps.llm,
          model: effectiveModel,
          messages,
          tools: toolDefs,
          responseFormat,
          policy: retryPolicy,
          deadline,
          onRetry: reportRetry,
          emitter: deps.emitter,
          runtimeId: manifest.name,
          pluginId: manifest.pluginId,
        });
      }
    } else {
      // Non-streaming path: helper handles transient-error + call-timeout
      // retry. A narrow secondary retry covers the DeepSeek-specific
      // "function.arguments JSON format" error which isTransientError does
      // not classify as retriable on its own.
      try {
        response = await callLLMWithRetry({
          llm: deps.llm,
          model: effectiveModel,
          messages,
          tools: toolDefs,
          responseFormat,
          policy: retryPolicy,
          deadline,
          onRetry: reportRetry,
          emitter: deps.emitter,
          runtimeId: manifest.name,
          pluginId: manifest.pluginId,
        });
      } catch (error) {
        const cause = error instanceof LLMRetryError ? error.cause : error;
        if (!toolDefs || !shouldRetryMalformedToolArguments(cause)) {
          throw error;
        }
        const fallbackCallStart = Date.now();
        if (deps.emitter) {
          // Malformed-tool-arguments fallback bypasses the retry helper, so
          // provider identity is not available here. Explicit `null` signals
          // "provider unknown at this call site" and survives JSON serialisation
          // (unlike `undefined`, which is dropped), keeping the payload schema
          // uniform across all 4 emit sites.
          await deps.emitter.emit(
            "llm.calling",
            buildLlmCallingPayload({
              runtimeId: manifest.name,
              pluginId: manifest.pluginId,
              slot: effectiveModel,
              model: effectiveModel,
              provider: null,
              messages,
              tools: toolDefs,
              attempt: 0,
            }),
          );
        }
        try {
          response = await deps.llm.generate({
            model: effectiveModel,
            messages,
            tools: toolDefs,
            responseFormat,
            signal: AbortSignal.timeout(
              Math.max(
                1000,
                Math.min(retryPolicy.callTimeoutMs, deadline - Date.now()),
              ),
            ),
          });
        } catch (fallbackErr) {
          // Pair every `llm.calling` with an `llm.responded` on the error
          // path so trace-viewer pairing stays intact when this fallback
          // generate throws.
          if (deps.emitter) {
            await deps.emitter.emit(
              "llm.responded",
              buildLlmRespondedErrorPayload({
                runtimeId: manifest.name,
                pluginId: manifest.pluginId,
                error: fallbackErr,
                durationMs: Date.now() - fallbackCallStart,
                attempt: 0,
              }),
            );
          }
          throw fallbackErr;
        }
        if (deps.emitter) {
          await deps.emitter.emit(
            "llm.responded",
            buildLlmRespondedSuccessPayload({
              runtimeId: manifest.name,
              pluginId: manifest.pluginId,
              response,
              durationMs: Date.now() - fallbackCallStart,
              attempt: 0,
            }),
          );
        }
      }
    }

    if (response.toolCalls.length > 0) {
      // LLM requested tool calls — execute them and feed results back.
      // Capture any narrative text produced alongside tool calls.
      if (response.content) {
        finalContent = response.content;
      }

      // Push assistant message with tool_calls (required by OpenAI protocol).
      // Without this, the next LLM call fails because tool-role messages
      // reference tool_call_ids that don't appear in any assistant message.
      // reasoningContent is carried back verbatim so thinking-mode
      // providers (DashScope Qwen, DeepSeek v4) accept the follow-up turn.
      messages.push({
        role: "assistant",
        content: response.content ?? "",
        toolCalls: response.toolCalls,
        ...(response.reasoningContent
          ? { reasoningContent: response.reasoningContent }
          : {}),
      });

      for (const tc of response.toolCalls) {
        if (deps.toolExecutor) {
          const tcStart = Date.now();

          // ── PreToolUse hook (S4-T3) ──────────────────────────
          const preToolOpts = {
            pipeline: hookPipeline,
            sessionId: input.sessionId,
            turnId: input.turnId,
            pluginId: manifest.pluginId,
            runtimeId: manifest.name,
            eventBus: deps.eventBus,
            emitter: deps.emitter,
          };
          const preToolOutcome = await runPreToolUseHook(preToolOpts, {
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          });
          if (preToolOutcome.skipped) {
            // Skip tool execution; push synthetic tool-role message so LLM sees a result
            messages.push({
              role: "tool",
              content: JSON.stringify({
                error: `pre-tool-use hook aborted: ${preToolOutcome.reason}`,
              }),
              toolCallId: tc.id,
            });
            continue;
          }

          // Use the (possibly replaced) toolCall from the hook outcome
          const effectiveTc = preToolOutcome.toolCall;

          const result = await deps.toolExecutor.execute(
            {
              toolCallId: effectiveTc.id,
              name: effectiveTc.name,
              arguments: effectiveTc.arguments,
            },
            {
              sessionId: input.sessionId,
              turnId: input.turnId,
              pluginId: manifest.pluginId,
              runtimeId: manifest.name,
              pendingProposals: pendingProposals,
              emitter: deps.emitter,
            },
          );

          // ── PostToolUse hook (S4-T3) ─────────────────────────
          const toolResult = await runPostToolUseHook(
            preToolOpts,
            {
              id: effectiveTc.id,
              name: effectiveTc.name,
              arguments: effectiveTc.arguments,
            },
            result,
          );

          if (!toolResult.success) {
            failedToolCalls.push({
              toolName: effectiveTc.name,
              message: extractToolFailureMessage(toolResult.result),
            });
          }

          if (
            toolResult.pendingProposals &&
            toolResult.pendingProposals.length > 0
          ) {
            pendingProposals.push(...toolResult.pendingProposals);
          }

          // ── Suspend detection (S4-T4) ────────────────────────
          // When COVEL_SUSPEND_V1=1 and the suspend tool was called, capture
          // the current loop state and persist a SuspensionRecord. The tool
          // result is NOT pushed back to the LLM — instead we exit the loop
          // with status 'suspended'.
          if (
            isEnvEnabled("COVEL_SUSPEND_V1") &&
            isSuspendSentinel(toolResult.parsedResult) &&
            deps.store
          ) {
            const sentinel = toolResult.parsedResult;
            const suspensionId = crypto.randomUUID();

            // Messages array currently has the assistant message (with tool_calls)
            // but not the suspend tool result. We capture the full message
            // array together with any buffered proposals so resume can
            // continue with the same mid-turn write set.
            const pendingContinuation: SuspensionRecord["pendingContinuation"] =
              {
                messages: [...messages],
                partialContent: finalContent ?? undefined,
                toolCallsSoFar: [...collectedToolCalls],
                pendingProposals: [...pendingProposals],
                // Store the suspend tool's call ID so resume can append a proper tool result
                suspendToolCallId: effectiveTc.id,
              };

            const suspension: SuspensionRecord = {
              id: suspensionId,
              sessionId: input.sessionId,
              turnId: input.turnId,
              runtimeId: manifest.name,
              pluginId: manifest.pluginId,
              reason: sentinel.reason,
              resumeSchema: sentinel.resumeSchema,
              pendingContinuation,
              createdAt: new Date().toISOString(),
            };

            await deps.store.saveSuspension(suspension);

            // Emit turn.suspended SSE event via the actions channel.
            // Include pluginId/runtimeId/suspendedAt so web clients can
            // render a suspension row without a follow-up REST fetch
            // (F4 web suspend/resume integration).
            emitSubEvent(
              deps.eventBus,
              "game",
              "turn.suspended",
              input.sessionId,
              {
                sessionId: input.sessionId,
                turnId: input.turnId,
                suspensionId,
                pluginId: manifest.pluginId,
                runtimeId: manifest.name,
                suspendedAt: suspension.createdAt,
                reason: sentinel.reason,
                resumeSchema: sentinel.resumeSchema,
              },
            );

            const suspendedResult: RuntimeResult = {
              pluginId: manifest.pluginId,
              runtimeId: manifest.name,
              runId,
              turnId: input.turnId,
              status: "suspended",
              output: {
                suspended: true,
                suspensionId,
                reason: sentinel.reason,
                resumeSchema: sentinel.resumeSchema,
              },
              toolCalls: collectedToolCalls,
              durationMs: Date.now() - startTime,
              timestamp: new Date().toISOString(),
            };

            try {
              await deps.onRuntimeComplete?.({
                runtimeId: manifest.name,
                pluginId: manifest.pluginId,
                status: "suspended",
                durationMs: suspendedResult.durationMs,
              });
            } catch {
              /* callback error must not kill runtime */
            }

            emitSubEvent(
              deps.eventBus,
              "runtime",
              "runtime.completed",
              input.sessionId,
              {
                runtimeId: manifest.name,
                pluginId: manifest.pluginId,
                status: "suspended",
                durationMs: suspendedResult.durationMs,
              },
            );

            return runPostRuntimeHook(
              {
                pipeline: hookPipeline,
                sessionId: input.sessionId,
                turnId: input.turnId,
                pluginId: manifest.pluginId,
                runtimeId: manifest.name,
                eventBus: deps.eventBus,
                emitter: deps.emitter,
              },
              suspendedResult,
            );
          }

          executedToolCalls.push({
            name: effectiveTc.name,
            arguments: effectiveTc.arguments,
            result: toolResult.parsedResult,
            success: toolResult.success,
          });

          // Build ToolCallRecord for RuntimeResult.toolCalls
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = JSON.parse(effectiveTc.arguments) as Record<
              string,
              unknown
            >;
          } catch {
            /* keep empty */
          }
          collectedToolCalls.push({
            toolCallId: effectiveTc.id,
            toolName: effectiveTc.name,
            pluginId: manifest.pluginId,
            runtimeId: manifest.name,
            turnId: input.turnId,
            input: parsedInput,
            output: toolResult.parsedResult,
            durationMs: Date.now() - tcStart,
            approvalStatus: toolResult.approvalStatus ?? "auto-allowed",
            timestamp: new Date().toISOString(),
          });

          messages.push({
            role: "tool",
            content: toolResult.result,
            toolCallId: effectiveTc.id,
          });
        } else {
          messages.push({
            role: "tool",
            content: JSON.stringify({
              result: "Tool execution not available",
            }),
            toolCallId: tc.id,
          });
        }
      }

      // Runtime-done early exit. If any tool call in this round was the
      // builtin `runtime-done` tool, the LLM has declared completion —
      // break immediately instead of burning another round-trip for a
      // terminator message. Business tool outputs from this round are
      // already in collectedToolCalls and become the runtime's output.
      // See packages/tools/src/builtin/runtime-done.ts for the sentinel
      // and buildFrameworkPreamble for the prompt contract.
      const doneCall = executedToolCalls.find((c) =>
        isRuntimeDoneSentinel(c.result),
      );
      if (doneCall) {
        // The runtime-done tool itself should not appear as a business
        // output — drop it from collected calls so downstream consumers
        // (proposal collector, trace) see only the real work.
        const businessCalls = collectedToolCalls.filter(
          (c) => c.toolName !== "runtime-done",
        );
        collectedToolCalls.length = 0;
        collectedToolCalls.push(...businessCalls);
        // Preserve streamed / captured prose from earlier steps or this
        // step's response.content. Without this guard a story runtime that
        // interleaves narrative prose + tool calls + runtime-done would lose
        // every token of narrative to the JSON envelope below. Only fall
        // back to the envelope when the runtime produced NO prose at all
        // (plugin/system runtimes that call a tool and exit silently).
        if (!finalContent) {
          finalContent =
            businessCalls.length > 0
              ? JSON.stringify({
                  toolCalls: businessCalls.map((c) => ({
                    name: c.toolName,
                    output: c.output,
                  })),
                })
              : "";
        }
        stoppedWithResponse = true;
        break;
      }

      // Tool-loop detection: when the LLM keeps emitting the exact same
      // tool call (name + JSON args) `threshold` times in a row it's
      // almost certainly stuck in a KV-cache echo. Inject a perturbation
      // system message to nudge it onto a different path; on the second
      // detection give up so the loop cannot wedge the runtime forever.
      if (retryPolicy.loopDetectionThreshold > 0) {
        const identityCalls = collectedToolCalls.map((c) => ({
          name: c.toolName,
          arguments:
            typeof c.input === "string"
              ? c.input
              : JSON.stringify(c.input ?? {}),
        }));
        if (detectToolLoop(identityCalls, retryPolicy.loopDetectionThreshold)) {
          if (loopPerturbations >= 1) {
            throw new Error(
              `tool-loop detected for ${manifest.name}: same tool "${identityCalls[identityCalls.length - 1]?.name}" called ${retryPolicy.loopDetectionThreshold}+ times with identical arguments even after perturbation`,
            );
          }
          loopPerturbations++;
          const [hint] = perturbMessages([], 1, "tool-loop-detected");
          if (hint) {
            messages.push(hint);
            console.warn(
              `[runtime-loop] ${manifest.name} detected repeated tool call; injected perturbation (attempt ${loopPerturbations})`,
            );
          }
        }
      }

      // Continue loop — LLM sees tool results and decides next action
      continue;
    }

    // Final response (no more tool calls)
    finalContent = response.content;
    stoppedWithResponse = true;
    break;
  }

  return {
    finalContent,
    collectedToolCalls,
    executedToolCalls,
    failedToolCalls,
    pendingProposals,
    streamDeltaCount,
    stoppedWithResponse,
    effectiveMaxSteps,
    deadline,
  };
}
