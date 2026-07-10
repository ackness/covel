import type {
  Proposal,
  RuntimeManifest,
  RuntimeResult,
  ToolCallRecord,
  TurnInput,
} from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import {
  isSuspendSentinel,
  isRuntimeDoneSentinel,
  type EmittedEvent,
} from "@covel/tools";
import type { LLMMessage } from "../llm/llm-adapter.js";
import type { HookPipeline } from "../hooks/pipeline.js";
import type { RetryInfo } from "../retry/llm-retry.js";
import { buildAgentLoopPolicy } from "./agent-loop-policy.js";
import { createDeltaForwarder } from "./delta-forwarder.js";
import { requestLLMResponse } from "./tool-loop-handler.js";
import { handleSuspension } from "../resume/suspend-resume-handler.js";
import { guardAgainstToolLoop, type LoopGuardState } from "./loop-detection.js";
import {
  runPreToolUseHook,
  runPostToolUseHook,
  runPreLLMCallHook,
  runPostLLMResponseHook,
} from "../hooks/wire-helpers.js";
import {
  extractToolFailureMessage,
  type ExecutedToolCallState,
  type FailedToolCallState,
} from "../turn-executor/turn-output-helpers.js";
import {
  buildAssistantToolCallMessage,
  buildPreToolAbortMessage,
  buildToolExecutionUnavailableMessage,
  buildToolResultMessage,
} from "./turn-agent-tool-loop-messages.js";
import type { AgentLoopDeps } from "../turn-executor/turn-executor-types.js";
import { TurnAbortedError } from "../turn-executor/turn-control.js";

export interface AgentToolLoopCompleted {
  readonly finalContent: string | null;
  readonly collectedToolCalls: ToolCallRecord[];
  readonly executedToolCalls: ExecutedToolCallState[];
  readonly failedToolCalls: FailedToolCallState[];
  readonly pendingProposals: Proposal[];
  /** Domain events emitted via `emit-event` tool calls this loop — merged into `output.events` at finalize. */
  readonly emittedEvents: EmittedEvent[];
  readonly streamDeltaCount: number;
  readonly stoppedWithResponse: boolean;
  readonly effectiveMaxSteps: number;
  readonly deadline: number;
}

export type AgentToolLoopResult = AgentToolLoopCompleted | RuntimeResult;

/**
 * Mid-loop state seeded into {@link runAgentToolLoop}. The normal execution
 * path leaves this empty (fresh loop); the resume path rebuilds it from a
 * persisted {@link import("@covel/store").SuspensionRecord} so a
 * suspended-then-resumed runtime continues with the same write set it had when
 * it suspended.
 */
export interface AgentToolLoopInitialState {
  readonly finalContent?: string | null;
  readonly collectedToolCalls?: readonly ToolCallRecord[];
  readonly pendingProposals?: readonly Proposal[];
}

export interface RunAgentToolLoopOptions {
  readonly manifest: RuntimeManifest;
  readonly input: TurnInput;
  readonly loaded: LoadedRuntime;
  readonly deps: AgentLoopDeps;
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly messages: LLMMessage[];
  readonly hookPipeline: HookPipeline | undefined;
  readonly startTime: number;
  readonly runId: string;
  /** Seed mid-turn state — used by the resume path. Omitted = fresh loop. */
  readonly initialState?: AgentToolLoopInitialState;
  /**
   * Whether a suspend sentinel may suspend this loop. The normal path allows it
   * (`true`, default); the resume path forbids re-suspending mid-resume and
   * instead feeds the LLM a "Nested suspend is not supported" tool result.
   */
  readonly allowSuspend?: boolean;
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
  initialState,
  allowSuspend = true,
}: RunAgentToolLoopOptions): Promise<AgentToolLoopResult> {
  // LLM call with tool-calling loop. State is seeded from `initialState` so the
  // resume path continues from the persisted suspension; the normal path passes
  // nothing and starts fresh.
  let finalContent: string | null = initialState?.finalContent ?? null;
  const collectedToolCalls: ToolCallRecord[] = [
    ...(initialState?.collectedToolCalls ?? []),
  ];
  const executedToolCalls: ExecutedToolCallState[] = [];
  const failedToolCalls: FailedToolCallState[] = [];
  const pendingProposals: Proposal[] = [
    ...(initialState?.pendingProposals ?? []),
  ];
  // Fresh per loop run — not seeded from initialState. A suspend mid-round
  // that follows an emit-event call in the same LLM response would lose that
  // event on resume; narrow edge case, not covered by SuspensionRecord today.
  const emittedEvents: EmittedEvent[] = [];
  let steps = 0;

  const deadline = Date.now() + timeoutMs;
  let stoppedWithResponse = false;

  // All HOW-to-run decisions (tool surface, response format, model override,
  // streaming gate, step/retry budgets) live in the policy module — the loop
  // below is control flow only.
  const {
    toolDefs,
    responseFormat,
    runtimeModelOverride,
    useStreaming,
    effectiveMaxSteps,
    retryPolicy,
    requireToolUse,
    acceptsSteering,
  } = buildAgentLoopPolicy({
    manifest,
    input,
    loaded,
    deps,
    maxSteps,
    timeoutMs,
  });

  // The loop's single narrative outlet — counts chunks for `message.completed`.
  const delta = createDeltaForwarder({
    onDelta: deps.onDelta,
    runtimeId: manifest.name,
    pluginId: manifest.pluginId,
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
  const loopGuardState: LoopGuardState = { loopPerturbations: 0 };

  // Shared hook wiring reused across the LLM-call and tool-call sites below.
  const hookOpts = {
    pipeline: hookPipeline,
    sessionId: input.sessionId,
    turnId: input.turnId,
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    eventBus: deps.eventBus,
    emitter: deps.emitter,
  };
  // Set by a PostToolUse hook returning `terminate` — ends the loop after the
  // current response's tool calls are recorded.
  let terminatedByHook = false;
  // requireToolUse: how many times we've already nudged a bare (no-tool-call)
  // finish back into the loop. Capped at one correction so a model that keeps
  // refusing to call its tool is released instead of burning maxSteps.
  let noToolCallCorrections = 0;

  while (steps < effectiveMaxSteps && Date.now() < deadline) {
    steps++;

    // ── Player turn control (W4) ─────────────────────────────────
    // Abort: cut before spending another LLM call (the in-flight call is
    // additionally cut by the retry layer via the same signal). Steering:
    // merge queued player interjections into the live transcript so the
    // next LLM step sees them.
    if (deps.turnControl?.signal?.aborted) {
      throw new TurnAbortedError(
        `turn aborted by player during ${manifest.name}`,
      );
    }
    if (acceptsSteering) {
      for (const steer of deps.turnControl?.drainSteering?.() ?? []) {
        messages.push({ role: "user", content: steer });
      }
    }

    // Model resolution chain for story runtimes:
    // API override > plugin llm.toml > manifest.model > undefined.
    // Tool-heavy plugin runtimes stay on their declared slot so E2E story
    // overrides do not destabilize function-calling behaviour.
    const effectiveModel = deps.resolveModel
      ? deps.resolveModel(manifest, runtimeModelOverride)
      : (runtimeModelOverride ?? manifest.model);

    // ── PreLLMCall hook ──────────────────────────────────────────
    // Lets plugins non-destructively rewrite the request sent on THIS call
    // (messages / model / tools) without mutating the canonical transcript.
    const llmRequest = await runPreLLMCallHook(hookOpts, {
      messages,
      model: effectiveModel,
      tools: toolDefs,
    });

    let response = await requestLLMResponse({
      manifest,
      deps,
      messages: llmRequest.messages as LLMMessage[],
      effectiveModel: llmRequest.model,
      toolDefs: llmRequest.tools,
      responseFormat,
      retryPolicy,
      deadline,
      useStreaming,
      reportRetry,
      onStreamDelta: delta.forward,
    });

    // ── PostLLMResponse hook ─────────────────────────────────────
    // Inspect / patch the response (content, toolCalls) before tool dispatch.
    response = await runPostLLMResponseHook(hookOpts, response);

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
      messages.push(buildAssistantToolCallMessage(response));

      for (const tc of response.toolCalls) {
        if (deps.toolExecutor) {
          const tcStart = Date.now();

          // ── PreToolUse hook (S4-T3) ──────────────────────────
          const preToolOutcome = await runPreToolUseHook(hookOpts, {
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          });
          if (preToolOutcome.skipped) {
            // Skip tool execution; push synthetic tool-role message so LLM sees a result
            messages.push(
              buildPreToolAbortMessage({
                toolCallId: tc.id,
                reason: preToolOutcome.reason,
              }),
            );
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
              emittedEventTopics: emittedEvents.map((e) => e.topic),
              emitter: deps.emitter,
            },
          );

          // ── PostToolUse hook (S4-T3) ─────────────────────────
          const { result: toolResult, terminate: terminateAfterTool } =
            await runPostToolUseHook(
              hookOpts,
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

          if (toolResult.emittedEvents && toolResult.emittedEvents.length > 0) {
            emittedEvents.push(...toolResult.emittedEvents);
          }

          // ── Suspend detection (S4-T4) ────────────────────────
          // When the suspend tool is called, capture the current loop state and
          // persist a SuspensionRecord. The tool result is not pushed back to
          // the LLM; instead we exit the loop with status 'suspended'.
          //
          // The resume path runs the same loop with `allowSuspend: false`: a
          // nested suspend mid-resume is unsupported, so the sentinel is fed
          // back to the LLM as an error tool result and the loop continues.
          if (isSuspendSentinel(toolResult.parsedResult)) {
            if (!allowSuspend) {
              messages.push(
                buildToolResultMessage({
                  toolCallId: effectiveTc.id,
                  content: JSON.stringify({
                    error: "Nested suspend is not supported",
                  }),
                }),
              );
              continue;
            }
            if (deps.store) {
              return handleSuspension({
                sentinel: toolResult.parsedResult,
                manifest,
                input,
                deps,
                hookPipeline,
                messages,
                finalContent,
                collectedToolCalls,
                pendingProposals,
                suspendToolCallId: effectiveTc.id,
                startTime,
                runId,
              });
            }
            // allowSuspend but no store: fall through and treat the sentinel as
            // an ordinary tool result (unchanged pre-suspend-feature behaviour).
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

          messages.push(
            buildToolResultMessage({
              toolCallId: effectiveTc.id,
              content: toolResult.result,
            }),
          );

          // PostToolUse hook requested loop termination. Stop processing
          // further tool calls in this response and exit the loop below.
          if (terminateAfterTool) {
            terminatedByHook = true;
            break;
          }
        } else {
          messages.push(buildToolExecutionUnavailableMessage(tc.id));
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

      // Hook-driven termination (after runtime-done handling, so a same-round
      // `runtime-done` call still gets its sentinel-strip + envelope cleanup
      // above). The response's prose, if any, is already in finalContent.
      if (terminatedByHook) {
        stoppedWithResponse = true;
        break;
      }

      // Tool-loop detection: when the LLM keeps emitting the exact same
      // tool call (name + JSON args) `threshold` times in a row it's
      // almost certainly stuck in a KV-cache echo. Inject a perturbation
      // system message to nudge it onto a different path; on the second
      // detection give up so the loop cannot wedge the runtime forever.
      guardAgainstToolLoop({
        collectedToolCalls,
        threshold: retryPolicy.loopDetectionThreshold,
        runtimeName: manifest.name,
        messages,
        state: loopGuardState,
      });

      // Continue loop — LLM sees tool results and decides next action
      continue;
    }

    // requireToolUse gate: a runtime whose whole job is to call a tool has
    // drifted into free-form prose (zero tool calls, nothing executed). Nudge
    // it back once with a corrective system message; on a second bare finish
    // release it (maxSteps still bounds the loop) so a stubborn model cannot
    // wedge the runtime. Only fires when no tool ever executed successfully —
    // a runtime that did its work and then narrated is left alone.
    if (requireToolUse && !executedToolCalls.some((c) => c.success)) {
      if (noToolCallCorrections === 0) {
        noToolCallCorrections++;
        console.warn(
          `[runtime-retry] ${manifest.name} attempt=${noToolCallCorrections} reason=no-tool-call cause=finished without calling any tool`,
        );
        messages.push({
          role: "system",
          content: input.locale?.toLowerCase().startsWith("zh")
            ? "你没有调用任何工具就结束了。必须先调用声明的工具完成任务，再收尾。"
            : "You finished without calling any tool. Call the declared tools to complete the task first, then wrap up.",
        });
        continue;
      }
      console.warn(
        `[runtime-retry] ${manifest.name} reason=no-tool-call cause=still no tool call after correction; releasing`,
      );
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
    emittedEvents,
    streamDeltaCount: delta.count(),
    stoppedWithResponse,
    effectiveMaxSteps,
    deadline,
  };
}
