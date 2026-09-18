import { getTurnExecutionSignal } from "../turn-executor/turn-control.js";
import type {
  Proposal,
  ExecutionContext,
  RuntimeManifest,
  RuntimeResult,
  ToolCallRecord,
  TurnInput,
  InputSlot,
  LLMTargetIdentity,
} from "@covel/shared";
import { isDefaultLocale, toJsonValueOrDiagnostic } from "@covel/shared";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import {
  isSuspendSentinel,
  isRuntimeDoneSentinel,
  type EmittedEvent,
} from "@covel/tools";
import type { LLMMessage } from "../llm/llm-adapter.js";
import type { HookPipeline } from "../hooks/pipeline.js";
import type { RetryInfo } from "../retry/llm-retry.js";
import { buildAgentLoopPolicy } from "./agent-loop-policy.js";
import { prepareBudgetedRequest } from "./request-context-budget.js";
import { createDeltaForwarder } from "./delta-forwarder.js";
import { executeToolSearch, SEARCH_TOOLS_TOOL_NAME } from "./tool-search.js";
import { requestLLMResponse } from "./tool-loop-handler.js";
import { handleSuspension } from "../resume/suspend-resume-handler.js";
import { guardAgainstToolLoop, type LoopGuardState } from "./loop-detection.js";
import {
  runPreToolUseHook,
  runPostToolUseHook,
  runPreLLMCallHook,
} from "../hooks/wire-helpers.js";
import { createResponseReviewer } from "./response-review.js";
import {
  extractToolFailureMessage,
  isRecord,
  parseFinalOutputEnvelope,
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
import { throwIfTurnExecutionAborted } from "../turn-executor/turn-control.js";
import { storyOutputError } from "./story-output.js";
import {
  checkTextCompletion,
  hasExplicitCompletion,
  captureCompletionCalls,
  type CompletionCalls,
} from "./runtime-completion.js";
import { type BudgetOptions, type TokenEstimator } from "@covel/context";

export interface AgentToolLoopCompleted {
  readonly finalContent: string | null;
  /** Structured result from the tool that completed this runtime. */
  readonly finalToolOutput: Record<string, unknown> | null;
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
  /** Required business tool work is still missing after the corrective step. */
  readonly requiredToolUseUnmet: boolean;
  readonly requiredCompletionUnmet: boolean;
  readonly lastTarget?: LLMTargetIdentity;
}

export type AgentToolLoopResult = AgentToolLoopCompleted | RuntimeResult;

/** Mid-loop state restored from a suspension; omitted for a fresh loop. */
export interface AgentToolLoopInitialState {
  readonly completionCalls?: CompletionCalls;
  readonly finalContent?: string | null;
  readonly collectedToolCalls?: readonly ToolCallRecord[];
  readonly pendingProposals?: readonly Proposal[];
  readonly emittedEvents?: readonly EmittedEvent[];
}

export interface RunAgentToolLoopOptions {
  readonly manifest: RuntimeManifest;
  readonly input: TurnInput;
  /** Authoritative logical turn number, forwarded into ToolCallContext. */
  readonly turnNumber?: number;
  readonly loaded: LoadedRuntime;
  readonly inputSlots?: Readonly<Record<string, InputSlot>>;
  readonly deps: AgentLoopDeps;
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly messages: LLMMessage[];
  /** Re-applied after hooks and before every provider call. */
  readonly estimator?: TokenEstimator;
  readonly contextBudget?: Omit<BudgetOptions, "estimator">;
  readonly hookPipeline: HookPipeline | undefined;
  readonly startTime: number;
  readonly runId: string;
  /** Original scheduling identity, persisted if this loop suspends. */
  readonly executionContext: ExecutionContext;
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
  turnNumber,
  loaded,
  inputSlots,
  deps,
  maxSteps,
  timeoutMs,
  messages,
  estimator,
  contextBudget,
  hookPipeline,
  startTime,
  runId,
  executionContext,
  initialState,
  allowSuspend = true,
}: RunAgentToolLoopOptions): Promise<AgentToolLoopResult> {
  // Resume starts with persisted loop state; ordinary execution starts fresh.
  let finalContent: string | null = initialState?.finalContent ?? null;
  let lastTarget: LLMTargetIdentity | undefined;
  let finalToolOutput: Record<string, unknown> | null = null;
  const collectedToolCalls: ToolCallRecord[] = [
    ...(initialState?.collectedToolCalls ?? []),
  ];
  const executedToolCalls: ExecutedToolCallState[] = [];
  // Work done before a suspension lives in the seeded `collectedToolCalls`
  // only — `executedToolCalls` always starts empty — so the requireToolUse
  // gate below must count it, or a resumed runtime that already called its
  // tool would be judged as having done nothing.
  const seededBusinessWork = (initialState?.collectedToolCalls ?? []).some(
    (c) => c.toolName !== "runtime-done",
  );
  // Set when `requireToolUse` released a runtime that never did business
  // work — the caller turns it into a failure rather than an empty success.
  let requiredToolUseUnmet = false;
  const failedToolCalls: FailedToolCallState[] = [];
  const pendingProposals: Proposal[] = [
    ...(initialState?.pendingProposals ?? []),
  ];
  const emittedEvents: EmittedEvent[] = [
    ...(initialState?.emittedEvents ?? []),
  ];
  let steps = 0;

  // Queue waits extend the deadline so they do not consume execution time.
  let deadline = Date.now() + timeoutMs;
  let stoppedWithResponse = false;

  // The policy owns tool surfaces, model settings, and execution budgets.
  const {
    toolDefs,
    deferredToolNames,
    responseFormat,
    runtimeModelOverride,
    useStreaming,
    effectiveMaxSteps,
    retryPolicy,
    requireToolUse,
    completeAfterTools,
    outputFromCompletingTool,
    acceptsSteering,
    authorizedToolNames,
  } = buildAgentLoopPolicy({
    manifest,
    input,
    loaded,
    deps,
    maxSteps,
    timeoutMs,
  });

  // search-tools can activate deferred tools for subsequent steps.
  let activeToolDefs = toolDefs;

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
      `[covel:warn] [runtime-retry] ${manifest.name} attempt=${info.attempt} reason=${info.reason} cause=${cause.slice(0, 200)}`,
    );
  };

  // Count how many times we injected a perturbation into `messages` due to
  // tool-loop detection. Once a loop has been perturbed and reappears, we
  // give up — another perturbation would not help.
  const loopGuardState: LoopGuardState = { loopPerturbations: 0 };

  // Shared hook wiring reused across the LLM-call and tool-call sites below.
  const hookOpts = {
    pipeline: hookPipeline,
    signal: getTurnExecutionSignal(deps.turnControl),
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
  const reviewResponse = createResponseReviewer(hookOpts, messages);
  // One correction for a bare finish that violates the tool-use contract.
  let noToolCallCorrections = 0;
  // Prose captured from steps that were extended by late steering (see the
  // late-steering drain below). Joined into finalContent at the final break
  // so the persisted narrative keeps both pre- and post-interjection text.
  const steeredProse: string[] = [];

  while (steps < effectiveMaxSteps && Date.now() < deadline) {
    steps++;

    // ── Player turn control ─────────────────────────────────
    // Abort: cut before spending another LLM call (the in-flight call is
    // additionally cut by the retry layer via the same signal). Steering:
    // merge queued player interjections into the live transcript so the
    // next LLM step sees them.
    throwIfTurnExecutionAborted(deps.turnControl, manifest.name);
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
      tools: activeToolDefs,
    });

    // Budget after hooks and tool results, immediately before each call.
    const budgetedRequest = await prepareBudgetedRequest({
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      messages: llmRequest.messages as LLMMessage[],
      tools: llmRequest.tools,
      responseFormat,
      retryPolicy,
      estimator,
      contextBudget,
      llm: deps.llm,
      slot: llmRequest.model,
      emitter: deps.emitter,
    });

    const rawResponse = await requestLLMResponse({
      manifest,
      deps,
      messages:
        budgetedRequest?.messages ?? (llmRequest.messages as LLMMessage[]),
      effectiveModel: llmRequest.model,
      toolDefs: llmRequest.tools,
      responseFormat,
      ...(budgetedRequest?.maxOutputTokens
        ? { maxOutputTokens: budgetedRequest.maxOutputTokens }
        : {}),
      retryPolicy,
      deadline,
      // Queue time at the LLM concurrency gate is the framework's cost:
      // shift the loop deadline by it so later steps keep their budget.
      onQueueWait: (waitedMs) => {
        deadline += waitedMs;
      },
      useStreaming: useStreaming && llmRequest.stream !== false,
      reportRetry,
      onStreamDelta: delta.forward,
    });

    lastTarget = rawResponse.target;
    const response = await reviewResponse(
      rawResponse,
      budgetedRequest?.messages ?? llmRequest.messages,
    );
    if (!response) {
      finalContent = null;
      continue;
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
      messages.push(buildAssistantToolCallMessage(response));

      let successfulCompletingToolsInResponse = 0;
      let failedBusinessToolsInResponse = 0;
      let completingToolOutputInResponse: Record<string, unknown> | null = null;

      for (
        let toolCallIndex = 0;
        toolCallIndex < response.toolCalls.length;
        toolCallIndex += 1
      ) {
        const tc = response.toolCalls[toolCallIndex]!;
        if (deps.toolExecutor) {
          const tcStart = Date.now();

          // ── PreToolUse hook ──────────────────────────
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

          // ── search-tools interception (deferred tool loading) ─
          // Framework-injected sentinel, same pattern as suspend /
          // runtime-done: never dispatched to the executor. Ranks the
          // still-deferred pool (BM25) and grows the working tool surface so
          // the NEXT LLM step can call the activated tools directly.
          if (
            effectiveTc.name === SEARCH_TOOLS_TOOL_NAME &&
            deferredToolNames.size > 0
          ) {
            const activeNames = new Set(
              (activeToolDefs ?? []).map((d) => d.name),
            );
            const search = executeToolSearch({
              argumentsJson: effectiveTc.arguments,
              deferredNames: deferredToolNames,
              activeNames,
              toolExecutor: deps.toolExecutor,
              context: {
                sessionId: input.sessionId,
                turnId: input.turnId,
                pluginId: manifest.pluginId,
                runtimeId: manifest.name,
              },
            });
            if (search.activated.length > 0) {
              activeToolDefs = [...(activeToolDefs ?? []), ...search.activated];
            }
            messages.push(
              buildToolResultMessage({
                toolCallId: effectiveTc.id,
                content: search.resultText,
              }),
            );
            executedToolCalls.push({
              name: effectiveTc.name,
              arguments: effectiveTc.arguments,
              result: search.parsedResult,
              success: true,
            });
            collectedToolCalls.push({
              toolCallId: effectiveTc.id,
              toolName: effectiveTc.name,
              pluginId: manifest.pluginId,
              runtimeId: manifest.name,
              turnId: input.turnId,
              input: {
                query: toJsonValueOrDiagnostic(
                  search.parsedResult.query,
                  "input.query",
                ),
              },
              output: toJsonValueOrDiagnostic(search.parsedResult, "output"),
              durationMs: Date.now() - tcStart,
              approvalStatus: "auto-allowed",
              timestamp: new Date().toISOString(),
            });
            continue;
          }

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
              inputSlots,
              emittedEventTopics: emittedEvents.map((e) => e.topic),
              emitter: deps.emitter,
              ...(turnNumber !== undefined ? { turnNumber } : {}),
              // Execution is bounded by the runtime's declared surface,
              // checked AFTER PreToolUse replacement produced effectiveTc.
              authorizedToolNames,
            },
          );

          // ── PostToolUse hook ─────────────────────────
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

          // ── Suspend detection ────────────────────────
          // When the suspend tool is called, capture the current loop state as
          // an execution-local artifact. The tool result is not pushed back to
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
            {
              // The captured assistant message contains the whole tool-call
              // batch. Provider protocols require a tool-role result for every
              // call before the next LLM request. Capture a placeholder for the
              // suspender (resume replaces its content) and explicitly cancel
              // later calls rather than leaving dangling ids in the transcript.
              messages.push(
                buildToolResultMessage({
                  toolCallId: effectiveTc.id,
                  content: JSON.stringify({ suspended: true }),
                }),
              );
              for (const skipped of response.toolCalls.slice(
                toolCallIndex + 1,
              )) {
                messages.push(
                  buildToolResultMessage({
                    toolCallId: skipped.id,
                    content: JSON.stringify({
                      error:
                        "Tool call skipped because an earlier call suspended the runtime",
                    }),
                  }),
                );
              }
              return handleSuspension({
                sentinel: toolResult.parsedResult,
                manifest,
                input,
                inputSlots,
                deps,
                hookPipeline,
                messages,
                finalContent,
                collectedToolCalls,
                completionCalls: captureCompletionCalls(
                  executedToolCalls,
                  initialState?.completionCalls,
                ),
                pendingProposals,
                emittedEvents,
                executionContext,
                suspendToolCallId: effectiveTc.id,
                startTime,
                runId,
              });
            }
          }

          executedToolCalls.push({
            name: effectiveTc.name,
            arguments: effectiveTc.arguments,
            result: toolResult.parsedResult,
            success: toolResult.success,
          });

          if (!isRuntimeDoneSentinel(toolResult.parsedResult)) {
            if (toolResult.success) {
              if (completeAfterTools.has(effectiveTc.name)) {
                successfulCompletingToolsInResponse++;
                if (isRecord(toolResult.parsedResult)) {
                  completingToolOutputInResponse = {
                    ...toolResult.parsedResult,
                  };
                }
              }
            } else failedBusinessToolsInResponse++;
          }

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
            input: toJsonValueOrDiagnostic(parsedInput, "input"),
            output: toJsonValueOrDiagnostic(toolResult.parsedResult, "output"),
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
        if (
          manifest.outputKind === "story" &&
          storyOutputError(
            finalContent ? parseFinalOutputEnvelope(finalContent).output : null,
          )
        ) {
          // A lookup is preparation, not a story. Give the model its remaining
          // bounded steps to write the narrative before accepting completion.
          finalContent = null;
          activeToolDefs = undefined;
          messages.push({
            role: "system",
            content: isDefaultLocale(input.locale)
              ? "你只完成了工具调用，还没有输出故事正文。现在根据已读取的信息直接写出本回合正文；不要再调用工具或解释处理过程。"
              : "You completed tool calls but have not written the story. Write this turn's narrative now using the information already retrieved. Do not call more tools or describe the processing steps.",
          });
          continue;
        }
        // A `requireToolUse` runtime can reach here having called nothing but
        // the terminator — a nudged model will do exactly that to satisfy
        // "call the declared tools". This exit runs before the gate below, so
        // record the unmet contract here or the runtime finishes as an empty
        // success.
        if (requireToolUse && businessCalls.length === 0) {
          requiredToolUseUnmet = true;
        }
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

      // Single-shot tool runtimes do not need to ask the model for a second
      // response whose only useful content is `runtime-done`. Execute the
      // whole response batch first and auto-complete only when every business
      // call in that batch succeeded. Failures stay in the transcript so the
      // model can inspect the tool result and retry on the next step.
      if (
        successfulCompletingToolsInResponse > 0 &&
        failedBusinessToolsInResponse === 0
      ) {
        if (outputFromCompletingTool && completingToolOutputInResponse) {
          // The tool arguments/result are the structured output channel. Ignore
          // incidental assistant prose and let the normal schema gate validate
          // the exact returned object before it reaches typed consumers.
          finalContent = null;
          finalToolOutput = completingToolOutputInResponse;
        } else if (!finalContent) {
          finalContent = JSON.stringify({
            toolCalls: collectedToolCalls
              .filter((call) => call.toolName !== "runtime-done")
              .map((call) => ({ name: call.toolName, output: call.output })),
          });
        }
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

    const completion = checkTextCompletion({
      manifest,
      calls: executedToolCalls,
      seededBusinessWork,
      corrections: noToolCallCorrections,
      locale: input.locale,
      prior: initialState?.completionCalls,
    });
    if (completion.correction) {
      noToolCallCorrections++;
      messages.push({ role: "system", content: completion.correction });
      continue;
    }
    requiredToolUseUnmet ||= completion.requiredToolUseUnmet;

    // Late steering: an interjection that arrived while THIS response
    // was streaming would otherwise sit queued until turn release and never
    // reach the current turn — the pre-step drain has already run, and a
    // bare prose finish (the common single-step story turn) ends the loop
    // here. Drain once more and take another step so the player's message
    // lands mid-turn. Bounded by effectiveMaxSteps like any other step.
    if (acceptsSteering && steps < effectiveMaxSteps) {
      const lateSteering = deps.turnControl?.drainSteering?.() ?? [];
      if (lateSteering.length > 0) {
        if (response.content) {
          messages.push({ role: "assistant", content: response.content });
          // Schema-shaped outputs stay last-wins — the final envelope is
          // the one that saw the steering; free prose is accumulated.
          if (!responseFormat) steeredProse.push(response.content);
        }
        for (const steer of lateSteering) {
          messages.push({ role: "user", content: steer });
        }
        continue;
      }
    }

    // Final response (no more tool calls)
    finalContent =
      steeredProse.length > 0
        ? [...steeredProse, response.content].filter(Boolean).join("\n\n")
        : response.content;
    stoppedWithResponse = true;
    break;
  }

  return {
    finalContent,
    finalToolOutput,
    collectedToolCalls,
    executedToolCalls,
    failedToolCalls,
    pendingProposals,
    emittedEvents,
    streamDeltaCount: delta.count(),
    stoppedWithResponse,
    effectiveMaxSteps,
    deadline,
    requiredToolUseUnmet,
    lastTarget,
    requiredCompletionUnmet:
      manifest.requireExplicitCompletion === true &&
      !hasExplicitCompletion(
        manifest,
        executedToolCalls,
        initialState?.completionCalls,
      ),
  };
}
