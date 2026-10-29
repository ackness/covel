import { isRecord } from "../utils/is-record.js";
import { overlayWorldModelView } from "../function-runtime/world-model-view.js";
import { createAgentLoopBudget } from "./agent-loop-budget.js";
import type {
  LoopStop,
  Proposal,
  ExecutionContext,
  RuntimeManifest,
  RuntimeResult,
  ToolCallRecord,
  TurnInput,
  InputSlot,
  LLMTargetIdentity,
} from "@covel/shared";
import {
  instructionLocaleFor,
  pluginMessagesFor,
  toJsonValueOrDiagnostic,
} from "@covel/shared";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import {
  isSuspendSentinel,
  isRuntimeDoneSentinel,
  parseJsonText,
  type EmittedEvent,
} from "@covel/tools";
import type { LLMMessage, LLMToolDefinition } from "@covel/shared";
import { promptCacheKeyFor } from "../llm/prompt-cache-key.js";
import type { HookPipeline } from "../hooks/pipeline.js";
import type { RetryInfo } from "../retry/llm-retry.js";
import { buildAgentLoopPolicy } from "./agent-loop-policy.js";
import type { ResolvedLoopProfile } from "./loop-profile.js";
import { prepareBudgetedRequest } from "./request-context-budget.js";
import { createDeltaForwarder } from "./delta-forwarder.js";
import { executeToolSearch, SEARCH_TOOLS_TOOL_NAME } from "./tool-search.js";
import { requestLLMResponse } from "./tool-loop-handler.js";
import {
  createPictureLoader,
  hasPictureAttachments,
  inlinePictureAttachments,
  withoutPictureAttachments,
} from "./picture-attachments.js";
import { handleSuspension } from "../resume/suspend-resume-handler.js";
import { guardAgainstToolLoop, type LoopGuardState } from "./loop-detection.js";
import {
  runPreToolUseHook,
  runPostToolUseHook,
  runPreLLMCallHook,
  runPreStepHook,
  type IncludedPromptSegment,
  type StepToolChoice,
} from "../hooks/wire-helpers.js";
import { createLoopState } from "./loop-state.js";
import { createStepRecorder, type StepRecorder } from "./step-events.js";
import { classifyLoopError, tagStop, tagging } from "./stop-reason.js";
import { createResponseReviewer } from "./response-review.js";
import {
  extractToolFailureMessage,
  parseFinalOutputEnvelope,
  type ExecutedToolCallState,
  type FailedToolCallState,
} from "../turn-executor/turn-output-helpers.js";
import {
  buildAssistantToolCallMessage,
  normalizeAssistantToolCall,
  buildPreToolAbortMessage,
  buildToolExecutionUnavailableMessage,
  buildToolResultMessage,
} from "./turn-agent-tool-loop-messages.js";
import type { AgentLoopDeps } from "../turn-executor/turn-executor-types.js";
import { storyOutputError } from "./story-output.js";
import {
  checkTextCompletion,
  hasBusinessWork,
  hasCompletedBusinessWork,
  hasExplicitCompletion,
  captureCompletionCalls,
  runtimeDoneCorrection,
  unresolvedToolFailures,
  type CompletionCalls,
} from "./runtime-completion.js";
import {
  DEFAULT_PROTECT_LAST_USER_TURNS,
  type BudgetOptions,
  type TokenEstimator,
} from "@covel/context";

export interface AgentToolLoopCompleted {
  readonly finalContent: string | null;
  /** Structured result from the tool that completed this runtime. */
  readonly finalToolOutput: Record<string, unknown> | null;
  readonly collectedToolCalls: ToolCallRecord[];
  readonly executedToolCalls: ExecutedToolCallState[];
  readonly failedToolCalls: FailedToolCallState[];
  readonly pendingProposals: Proposal[];
  /** Domain events emitted via `emit-event` tool calls this loop — merged into `effects.events` at finalize. */
  readonly emittedEvents: EmittedEvent[];
  readonly streamDeltaCount: number;
  /** How the loop ended. */
  readonly stop: LoopStop;
  /** The message a PreStep hook gave when it cancelled the loop. */
  readonly stopMessage?: string;
  /** The configured step limit; a PreStep hook may have lowered the one used. */
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
  readonly worldBase?: import("@covel/shared").WorldModelView;
  readonly upstreamProposals?: readonly Proposal[];
  /** Upstream writes of this plugin that tool store reads include, and the recorder. */
  readonly pluginDataVisibility?: import("../function-runtime/upstream-plugin-data.js").PluginDataVisibility;
  readonly manifest: RuntimeManifest;
  readonly input: TurnInput;
  /** Player messages recorded in the session, forwarded into the tool context. */
  readonly turnNumber?: number;
  /** The scheduler's logical turn, forwarded into the tool context. */
  readonly logicalTurn?: number;
  readonly loaded: LoadedRuntime;
  readonly inputSlots?: Readonly<Record<string, InputSlot>>;
  /** Passed to `PreLLMCall` hooks. Omitted on resume: nothing is assembled. */
  readonly promptSegments?: readonly IncludedPromptSegment[];
  readonly deps: AgentLoopDeps;
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly messages: LLMMessage[];
  /** Re-applied after hooks and before every provider call. */
  readonly estimator?: TokenEstimator;
  readonly contextBudget?: Omit<BudgetOptions, "estimator">;
  /**
   * User messages of the current turn in `messages`: the player's, and the
   * cue after this turn's story when there is one. The budget keeps the
   * whole turn, so it protects that many more than `contextBudget` says.
   * Default 1.
   */
  readonly currentTurnUserMessages?: number;
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

export async function runAgentToolLoop(
  options: RunAgentToolLoopOptions,
): Promise<AgentToolLoopResult> {
  const budget = createAgentLoopBudget(
    options.timeoutMs,
    options.manifest.name,
    options.deps.turnControl,
  );
  const stepEvents = createStepRecorder(options.deps.emitter, {
    runtimeId: options.manifest.name,
    pluginId: options.manifest.pluginId,
    turnId: options.input.turnId,
    runId: options.runId,
  });
  try {
    return await runAgentToolLoopWithinBudget(options, budget, stepEvents);
  } catch (error) {
    // Classify before `assertLive` expires a budget whose clock has run out:
    // that throws the loop's own timeout in place of `error`.
    const stop = classifyLoopError(error, budget, options.deps.turnControl);
    let thrown = error;
    try {
      budget.assertLive();
    } catch (abort) {
      thrown = abort;
    }
    if (stop) tagStop(thrown, stop);
    await stepEvents.close(stop?.reason, { thrown: true });
    throw thrown;
  } finally {
    budget.close();
  }
}

/**
 * Time a finalizer needs before the deadline. A finalizer that cannot finish
 * would only turn a step-limit failure into a timeout.
 */
const FINALIZER_MIN_REMAINING_MS = 3000;

async function runAgentToolLoopWithinBudget(
  {
    upstreamProposals = [],
    pluginDataVisibility,
    worldBase,
    manifest,
    input,
    turnNumber,
    logicalTurn,
    loaded,
    inputSlots,
    promptSegments,
    deps,
    maxSteps,
    timeoutMs,
    messages,
    estimator,
    contextBudget,
    currentTurnUserMessages: initialTurnUserMessages = 1,
    hookPipeline,
    startTime,
    runId,
    executionContext,
    initialState,
    allowSuspend = true,
  }: RunAgentToolLoopOptions,
  budget: ReturnType<typeof createAgentLoopBudget>,
  stepEvents: StepRecorder,
): Promise<AgentToolLoopResult> {
  // Resume starts with persisted loop state; ordinary execution starts fresh.
  let finalContent: string | null = initialState?.finalContent ?? null;
  let lastTarget: LLMTargetIdentity | undefined;
  let finalToolOutput: Record<string, unknown> | null = null;
  const collectedToolCalls: ToolCallRecord[] = [
    ...(initialState?.collectedToolCalls ?? []),
  ];
  const executedToolCalls: ExecutedToolCallState[] = [];
  // `executedToolCalls` always starts empty, so the requireToolUse gate below
  // reads work done before a suspension from the persisted execution evidence;
  // otherwise a resumed runtime that already called its tool would be judged
  // as having done nothing. The transcript is not evidence: a failed call
  // leaves a tool name there too.
  const seededBusinessWork = hasCompletedBusinessWork(
    manifest,
    initialState?.completionCalls,
  );
  // A failure still unresolved at the suspension stays visible to the
  // finalizer, as it would have without the suspension.
  const failedToolCalls: FailedToolCallState[] = unresolvedToolFailures(
    initialState?.completionCalls,
  ).map((toolName) => ({ toolName }));
  const pendingProposals: Proposal[] = [
    ...(initialState?.pendingProposals ?? []),
  ];
  const world = worldBase
    ? overlayWorldModelView(
        worldBase,
        input.sessionId,
        pendingProposals,
        () => budget.assertLive(),
        input.locale,
      )
    : undefined;
  const emittedEvents: EmittedEvent[] = [
    ...(initialState?.emittedEvents ?? []),
  ];
  // The loop's phase, step count and stop reason.
  const loop = createLoopState();
  // Set when a PreStep hook cancels the loop.
  let stopMessage: string | undefined;

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
    profile,
    authorizedToolNames,
  } = buildAgentLoopPolicy({
    manifest,
    input,
    loaded,
    deps,
    maxSteps,
    timeoutMs,
  });
  // The step limit in force. A PreStep hook may lower it, never raise it.
  let stepLimit = effectiveMaxSteps;

  // search-tools can activate deferred tools for subsequent steps.
  let activeToolDefs = toolDefs;

  // The loop's single narrative outlet — counts chunks for `message.completed`.
  // Only a profile that streams to the player forwards text.
  const delta = createDeltaForwarder({
    onDelta: profile.stream ? deps.onDelta : undefined,
    runtimeId: manifest.name,
    pluginId: manifest.pluginId,
  });

  const reportRetry = (info: RetryInfo): void => {
    const cause =
      info.error instanceof Error ? info.error.message : String(info.error);
    console.warn(
      `[covel:warn] [runtime-retry] ${manifest.name} attempt=${info.attempt} reason=${info.reason} cause=${cause.slice(0, 200)}`,
    );
    stepEvents.retry(info);
  };

  // Count how many times we injected a perturbation into `messages` due to
  // tool-loop detection. Once a loop has been perturbed and reappears, we
  // give up — another perturbation would not help.
  const loopGuardState: LoopGuardState = { loopPerturbations: 0 };

  // Shared hook wiring reused across the LLM-call and tool-call sites below.
  const hookOpts = {
    pipeline: hookPipeline,
    signal: budget.signal,
    sessionId: input.sessionId,
    turnId: input.turnId,
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    eventBus: deps.eventBus,
    emitter: deps.emitter,
  };
  // Set by a PostToolUse hook returning `terminate` — ends the loop. The calls
  // after the terminating one in the same response are not executed.
  let terminatedByHook = false;
  const reviewResponse = createResponseReviewer(
    hookOpts,
    messages,
    input.locale,
  );
  const pictureLoader = createPictureLoader(deps.mediaStore, input.sessionId);
  // A player's interjection is one more user message of the current turn.
  let currentTurnUserMessages = initialTurnUserMessages;
  // One correction for a bare finish that violates the tool-use contract.
  let noToolCallCorrections = 0;
  // The correction asked for a tool call; the next request requires one.
  let toolCallRequested = false;
  // Prose captured from steps that were extended by late steering (see the
  // late-steering drain below). Joined into finalContent at the final break
  // so the persisted narrative keeps both pre- and post-interjection text.
  const steeredProse: string[] = [];

  /**
   * One model request: PreLLMCall, pictures, the context budget, then the
   * provider call. Shared by every step and the finalizer.
   */
  const callModel = async (step: {
    readonly tools: readonly LLMToolDefinition[] | undefined;
    readonly toolChoice?: StepToolChoice;
    readonly requireToolCall: boolean;
  }) => {
    // Model resolution chain for story runtimes:
    // API override > manifest.model (a role the player binds) > undefined.
    // Tool-heavy plugin runtimes stay on their declared slot so E2E story
    // overrides do not destabilize function-calling behaviour.
    const effectiveModel = deps.resolveModel
      ? deps.resolveModel(manifest, runtimeModelOverride)
      : (runtimeModelOverride ?? manifest.model);

    // ── PreLLMCall hook ──────────────────────────────────────────
    // Lets plugins non-destructively rewrite the request sent on THIS call
    // (messages / model / tools) without mutating the canonical transcript.
    const hookedRequest = await runPreLLMCallHook(hookOpts, {
      messages,
      model: effectiveModel,
      tools: step.tools,
      ...(promptSegments ? { promptSegments } : {}),
    });
    // Pictures go only to a model known to read images. The hook may have
    // chosen another model, so the decision is made for this call.
    const sendPictures =
      hasPictureAttachments(hookedRequest.messages as LLMMessage[]) &&
      deps.llm.acceptsImageInput?.(hookedRequest.model) === true;
    const llmRequest = sendPictures
      ? hookedRequest
      : {
          ...hookedRequest,
          messages: withoutPictureAttachments(
            hookedRequest.messages as LLMMessage[],
          ),
        };

    // Budget after hooks and tool results, immediately before each call.
    const budgetedRequest = await tagging("context-overflow", () =>
      prepareBudgetedRequest({
        runtimeId: manifest.name,
        pluginId: manifest.pluginId,
        messages: llmRequest.messages as LLMMessage[],
        tools: llmRequest.tools,
        responseFormat,
        retryPolicy,
        estimator,
        // These limits are a fallback each call replaces, so they are not
        // checked here.
        contextBudget: contextBudget && {
          ...contextBudget,
          protectLastUserTurns:
            (contextBudget.protectLastUserTurns ??
              DEFAULT_PROTECT_LAST_USER_TURNS) +
            currentTurnUserMessages -
            1,
        },
        locale: input.locale,
        llm: deps.llm,
        slot: llmRequest.model,
        emitter: deps.emitter,
      }),
    );

    const requestMessages =
      budgetedRequest?.messages ?? (llmRequest.messages as LLMMessage[]);
    const sentMessages = sendPictures
      ? await inlinePictureAttachments(requestMessages, pictureLoader)
      : requestMessages;

    budget.pauseForModel();
    let rawResponse: Awaited<ReturnType<typeof requestLLMResponse>>;
    try {
      rawResponse = await tagging("model-error", () =>
        requestLLMResponse({
          manifest,
          deps,
          messages: sentMessages,
          effectiveModel: llmRequest.model,
          toolDefs: llmRequest.tools,
          responseFormat,
          locale: input.locale,
          promptCacheKey: promptCacheKeyFor(input.sessionId, manifest.name),
          ...(budgetedRequest?.maxOutputTokens
            ? { maxOutputTokens: budgetedRequest.maxOutputTokens }
            : {}),
          retryPolicy,
          deadline: budget.deadline,
          // Queue time at the LLM concurrency gate is the framework's cost:
          // shift the loop deadline by it so later steps keep their budget.
          onQueueWait: budget.extend,
          // A model that keeps writing is not cut off: the time its stream
          // spent delivering output does not count against the loop either.
          onStreamTime: budget.extend,
          useStreaming: useStreaming && llmRequest.stream !== false,
          reportRetry,
          onStreamDelta: profile.stream ? delta.forward : async () => {},
          deliversDeltas: profile.stream,
          allowTruncatedText: profile.truncation === "accept",
          requireToolCall: step.requireToolCall,
          ...(step.toolChoice ? { toolChoice: step.toolChoice } : {}),
        }),
      );
    } finally {
      budget.resumeAfterModel();
    }
    budget.assertLive();
    stepEvents.responded(rawResponse);
    return {
      rawResponse,
      reviewMessages: budgetedRequest?.messages ?? llmRequest.messages,
    };
  };

  /**
   * The finalizer step: tools off, no tool choice, the same response format,
   * streamed like any step. Returns its text, or undefined when it wrote
   * none, its draft was rejected, or the request failed. An abort or the
   * deadline propagates as in any step. Its tool calls are ignored.
   */
  const runFinalizer = async (step: number): Promise<string | undefined> => {
    await delta.reset();
    messages.push(answerWithoutTools(profile.answerPrompt, input.locale));
    await stepEvents.start({
      step,
      maxSteps: stepLimit,
      toolCount: 0,
      toolChoice: "auto",
      finalizer: true,
    });
    try {
      const { rawResponse, reviewMessages } = await callModel({
        tools: undefined,
        requireToolCall: false,
      });
      lastTarget = rawResponse.target;
      const response = await reviewResponse(rawResponse, reviewMessages);
      budget.assertLive();
      const text = response?.content?.trim() ? response.content : undefined;
      if (!text) await delta.reset();
      return text;
    } catch (error) {
      // Only an abort or the deadline ends the loop here; any other failure
      // leaves the step-limit failure in place.
      budget.assertLive();
      console.warn(
        `[runtime-loop] ${manifest.name} finalizer failed: ${
          error instanceof Error ? error.message.slice(0, 200) : String(error)
        }`,
      );
      await delta.reset();
      return undefined;
    }
  };

  /**
   * Whether a finalizer may run now: prose can satisfy the runtime's
   * completion contract, and there is time left to write it. Shared by the
   * step limit and the deadline reserve.
   */
  const finalizerEligible = (): boolean =>
    !outputFromCompletingTool &&
    (!requireToolUse ||
      hasBusinessWork(manifest, executedToolCalls, seededBusinessWork)) &&
    (manifest.requireExplicitCompletion !== true ||
      hasExplicitCompletion(
        manifest,
        executedToolCalls,
        initialState?.completionCalls,
      )) &&
    budget.deadline - Date.now() >= FINALIZER_MIN_REMAINING_MS;

  // The deadline reserve: no new step starts this close to the deadline when
  // a finalizer could write the answer instead. Off at 0; never more than
  // half the runtime's time.
  const deadlineReserveMs = Math.min(
    profile.finalizer.deadlineReserveMs,
    Math.floor(timeoutMs / 2),
  );
  let reserveReached = false;

  while (loop.steps < stepLimit && Date.now() < budget.deadline) {
    // Read the deadline here: queue and stream time have moved it.
    if (
      deadlineReserveMs > 0 &&
      budget.deadline - Date.now() < deadlineReserveMs &&
      finalizerEligible()
    ) {
      reserveReached = true;
      loop.stop = { reason: "deadline" };
      break;
    }
    loop.steps++;
    const step = loop.steps;

    // ── Player turn control ─────────────────────────────────
    // Abort: cut before spending another LLM call (the in-flight call is
    // additionally cut by the retry layer via the same signal). Steering:
    // merge queued player interjections into the live transcript so the
    // next LLM step sees them.
    loop.enter("awaiting-pre-step");
    budget.assertLive();
    await stepEvents.close();
    if (profile.steering) {
      for (const steer of deps.turnControl?.drainSteering?.() ?? []) {
        messages.push({ role: "user", content: steer });
        currentTurnUserMessages += 1;
      }
    }

    // ── PreStep hook ─────────────────────────────────────────────
    // Shapes this step only: the tool surface it narrows is not carried to
    // the next step, and execution stays bound by the manifest's surface.
    const toolNames = (activeToolDefs ?? []).map(
      (definition) => definition.name,
    );
    const loopToolChoice: StepToolChoice =
      manifest.llm?.toolChoice ??
      (toolCallRequested && toolNames.length > 0 ? "required" : "auto");
    const preStep = await runPreStepHook(hookOpts, {
      step,
      stepsRemaining: stepLimit - step + 1,
      maxSteps: stepLimit,
      toolNames,
      toolChoice: loopToolChoice,
    });
    if (preStep.tools || preStep.ignoredTools > 0)
      stepEvents.note({
        kind: "tool-narrowed",
        count: (preStep.tools ?? toolNames).length,
        ...(preStep.ignoredTools > 0 ? { ignored: preStep.ignoredTools } : {}),
      });
    if (preStep.stop) {
      // `tool-finished` ends the loop as a PostToolUse `terminate` does: the
      // completion contract is still judged in settle. `cancelled` returns
      // the loop's result so the failed runtime keeps its tool calls.
      if (preStep.stop.reason === "tool-finished")
        loop.stop = { reason: "tool-finished" };
      else {
        loop.stop = { reason: "cancelled", cancelledBy: "hook" };
        stopMessage = preStep.stop.message;
      }
      break;
    }
    if (preStep.stepsRemaining !== undefined)
      stepLimit = Math.min(stepLimit, step + preStep.stepsRemaining - 1);
    const narrowed = preStep.tools
      ? (activeToolDefs ?? []).filter((definition) =>
          preStep.tools!.includes(definition.name),
        )
      : undefined;
    const stepTools = narrowed
      ? narrowed.length > 0
        ? narrowed
        : undefined
      : activeToolDefs;
    await stepEvents.start({
      step,
      maxSteps: stepLimit,
      toolCount: stepTools?.length ?? 0,
      toolChoice: preStep.toolChoice ?? loopToolChoice,
    });

    loop.enter("requesting-model");
    const { rawResponse, reviewMessages } = await callModel({
      tools: stepTools,
      ...(preStep.toolChoice ? { toolChoice: preStep.toolChoice } : {}),
      requireToolCall: toolCallRequested,
    });

    lastTarget = rawResponse.target;
    loop.enter("reviewing");
    const response = await tagging("invalid-output", () =>
      reviewResponse(rawResponse, reviewMessages),
    );
    budget.assertLive();
    if (!response) {
      stepEvents.note({ kind: "review-rejected" });
      finalContent = null;
      // The rejected draft may already be on screen.
      await delta.reset();
      continue;
    }

    if (response.toolCalls.length > 0) {
      loop.enter("running-tools");
      toolCallRequested = false;
      // Preparation text before tool calls is not the final narrative.
      await delta.reset();
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
      const assistantMessageIndex = messages.length;
      messages.push(buildAssistantToolCallMessage(response));

      let successfulCompletingToolsInResponse = 0;
      let failedBusinessToolsInResponse = 0;
      let completingToolOutputInResponse: Record<string, unknown> | null = null;
      // Where this response's calls start in `executedToolCalls`.
      const firstCallOfResponse = executedToolCalls.length;

      for (
        let toolCallIndex = 0;
        toolCallIndex < response.toolCalls.length;
        toolCallIndex += 1
      ) {
        const tc = response.toolCalls[toolCallIndex]!;
        budget.assertLive();
        if (deps.toolExecutor) {
          const tcStart = Date.now();

          // ── PreToolUse hook ──────────────────────────
          const preToolOutcome = await runPreToolUseHook(hookOpts, {
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          });
          budget.assertLive();
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
          // The hook may rewrite the name or arguments. Replay that effective
          // call while the executor still receives the original argument text
          // so an unrepairable call remains INVALID_ARGS.
          const assistantMessage = messages[assistantMessageIndex]!;
          messages[assistantMessageIndex] = {
            ...assistantMessage,
            toolCalls: assistantMessage.toolCalls!.map((call, index) =>
              index === toolCallIndex
                ? normalizeAssistantToolCall(effectiveTc)
                : call,
            ),
          };

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
              stepEvents.note({
                kind: "tool-activated",
                count: search.activated.length,
              });
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
            stepEvents.toolCall(effectiveTc.name, true);
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
              locale: input.locale,
              messages: pluginMessagesFor(loaded.messages, input.locale),
              pendingProposals: pendingProposals,
              ...(pluginDataVisibility ? { pluginDataVisibility } : {}),
              upstreamProposals,
              world,
              signal: hookOpts.signal,
              inputSlots,
              emittedEventTopics: emittedEvents.map((e) => e.topic),
              emitter: deps.emitter,
              ...(turnNumber !== undefined ? { turnNumber } : {}),
              ...(logicalTurn !== undefined ? { logicalTurn } : {}),
              // Execution is bounded by the runtime's declared surface,
              // checked AFTER PreToolUse replacement produced effectiveTc.
              authorizedToolNames,
            },
          );
          budget.assertLive();

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
          budget.assertLive();

          if (!toolResult.success && !toolResult.refused) {
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
          // These names are reserved to builtins by ToolRegistry. A matching
          // field from a plugin tool is ordinary data, not loop control.
          // When the suspend tool is called, capture the current loop state as
          // an execution-local artifact. The tool result is not pushed back to
          // the LLM; instead we exit the loop with status 'suspended'.
          //
          // The resume path runs the same loop with `allowSuspend: false`: a
          // nested suspend mid-resume is unsupported, so the sentinel is fed
          // back to the LLM as an error tool result and the loop continues.
          if (
            effectiveTc.name === "suspend" &&
            toolResult.success &&
            isSuspendSentinel(toolResult.parsedResult)
          ) {
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
              loop.enter("suspended");
              loop.stop = { reason: "suspended" };
              await stepEvents.close("suspended");
              return handleSuspension({
                outputContractSchema: loaded.outputContractSchema,
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
                ...(logicalTurn !== undefined ? { logicalTurn } : {}),
                ...(turnNumber !== undefined ? { turnNumber } : {}),
                currentTurnUserMessages,
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
            ...(toolResult.refused ? { refused: true as const } : {}),
          });
          stepEvents.toolCall(effectiveTc.name, toolResult.success);

          if (
            effectiveTc.name !== "runtime-done" ||
            !toolResult.success ||
            !isRuntimeDoneSentinel(toolResult.parsedResult)
          ) {
            if (toolResult.success) {
              if (completeAfterTools.has(effectiveTc.name)) {
                successfulCompletingToolsInResponse++;
                if (isRecord(toolResult.parsedResult)) {
                  completingToolOutputInResponse = {
                    ...toolResult.parsedResult,
                  };
                }
              }
            } else if (!toolResult.refused) failedBusinessToolsInResponse++;
          }

          // Build ToolCallRecord for RuntimeResult.toolCalls
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = parseJsonText(effectiveTc.arguments) as Record<
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

      loop.enter("deciding");
      // Runtime-done early exit. If any tool call in this round was the
      // builtin `runtime-done` tool, the LLM has declared completion —
      // break immediately instead of burning another round-trip for a
      // terminator message. Business tool outputs from this round are
      // already in collectedToolCalls and become the runtime's output.
      // See packages/tools/src/builtin/runtime-done.ts for the sentinel
      // and buildFrameworkPreamble for the prompt contract.
      // Only this response's calls count. A `runtime-done` that was answered
      // with a correction stays in `executedToolCalls`; read again after a
      // later batch, it would end the loop before the model saw that batch's
      // results.
      const doneCall = executedToolCalls
        .slice(firstCallOfResponse)
        .find(
          (c) =>
            c.name === "runtime-done" &&
            c.success &&
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
        // The predicate is the story output contract; the correction is the
        // profile's fallback.
        if (
          profile.fallback === "answer-without-tools" &&
          profile.answerPrompt === "story" &&
          storyOutputError(
            finalContent ? parseFinalOutputEnvelope(finalContent).output : null,
          )
        ) {
          // A lookup is preparation, not a story. Give the model its remaining
          // bounded steps to write the narrative before accepting completion.
          finalContent = null;
          activeToolDefs = undefined;
          messages.push(writeStoryWithoutTools(input.locale));
          stepEvents.note({ kind: "story-without-tools" });
          continue;
        }
        // A `requireToolUse` runtime can reach here having called nothing but
        // the terminator — a nudged model will do exactly that to satisfy
        // "call the declared tools" — or after a business tool that failed.
        // A first `runtime-done` without business work gets the same single
        // correction as a bare text finish: bookkeeping runtimes often mean
        // "nothing changed", which their own tool must record. A second one
        // ends the loop, and the contract is judged where the loop returns.
        if (
          requireToolUse &&
          noToolCallCorrections === 0 &&
          !hasBusinessWork(manifest, executedToolCalls, seededBusinessWork)
        ) {
          noToolCallCorrections++;
          toolCallRequested = true;
          finalContent = null;
          messages.push({
            role: "system",
            content: runtimeDoneCorrection(input.locale),
          });
          stepEvents.note({ kind: "runtime-done-correction" });
          continue;
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
        loop.stop = { reason: "tool-finished" };
        break;
      }

      // Hook-driven termination (after runtime-done handling, so a same-round
      // `runtime-done` call still gets its sentinel-strip + envelope cleanup
      // above). The response's prose, if any, is already in finalContent.
      if (terminatedByHook) {
        loop.stop = { reason: "tool-finished" };
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
        loop.stop = { reason: "tool-finished" };
        break;
      }

      // Tool-loop detection: when the LLM keeps emitting the exact same
      // tool call (name + JSON args) `threshold` times in a row it's
      // almost certainly stuck in a KV-cache echo. Inject a perturbation
      // system message to nudge it onto a different path; on the second
      // detection give up so the loop cannot wedge the runtime forever.
      const perturbationsBefore = loopGuardState.loopPerturbations;
      try {
        guardAgainstToolLoop({
          collectedToolCalls,
          threshold: retryPolicy.loopDetectionThreshold,
          runtimeName: manifest.name,
          messages,
          state: loopGuardState,
          locale: input.locale,
        });
      } catch (err) {
        // A failed story fails the whole player turn. A story stuck repeating
        // a tool call (e.g. an event no active plugin consumes) still has
        // what it needs to narrate, and an actor can answer from its brief:
        // the profile's fallback takes the tools away and asks for the answer.
        if (
          profile.fallback !== "answer-without-tools" ||
          activeToolDefs === undefined
        ) {
          tagStop(err, { reason: "loop-detected" });
          throw err;
        }
        console.warn(
          `[runtime-loop] ${manifest.name} kept repeating a tool call; continuing without tools`,
        );
        finalContent = null;
        activeToolDefs = undefined;
        messages.push(answerWithoutTools(profile.answerPrompt, input.locale));
        stepEvents.note({ kind: "story-without-tools" });
      }
      if (loopGuardState.loopPerturbations > perturbationsBefore)
        stepEvents.note({ kind: "loop-perturbation" });

      // Continue loop — LLM sees tool results and decides next action
      continue;
    }

    loop.enter("deciding");
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
      toolCallRequested = true;
      await delta.reset();
      messages.push({ role: "system", content: completion.correction });
      stepEvents.note({ kind: "no-tool-correction" });
      continue;
    }

    // Late steering: an interjection that arrived while THIS response
    // was streaming would otherwise sit queued until turn release and never
    // reach the current turn — the pre-step drain has already run, and a
    // bare prose finish (the common single-step story turn) ends the loop
    // here. Drain once more and take another step so the player's message
    // lands mid-turn. Bounded by effectiveMaxSteps like any other step.
    if (profile.steering && loop.steps < stepLimit) {
      const lateSteering = deps.turnControl?.drainSteering?.() ?? [];
      if (lateSteering.length > 0) {
        stepEvents.note({ kind: "late-steering", count: lateSteering.length });
        if (response.content) {
          messages.push({ role: "assistant", content: response.content });
          // Schema-shaped outputs stay last-wins — the final envelope is
          // the one that saw the steering; free prose is accumulated.
          if (!responseFormat) {
            steeredProse.push(response.content);
            // The live text gets the break the final content joins with.
            await delta.forward("\n\n");
          }
        }
        for (const steer of lateSteering) {
          messages.push({ role: "user", content: steer });
          currentTurnUserMessages += 1;
        }
        continue;
      }
    }

    // Final response (no more tool calls)
    finalContent =
      steeredProse.length > 0
        ? [...steeredProse, response.content].filter(Boolean).join("\n\n")
        : response.content;
    loop.stop = { reason: "completed" };
    break;
  }

  // No `break` set a reason: the loop ended at its gate. The deadline case
  // throws at `assertLive` below, and the outer catch tags it.
  loop.stop ??=
    loop.steps >= stepLimit ? { reason: "max-steps" } : { reason: "deadline" };

  // ── Finalizer ──────────────────────────────────────────────────
  // A step limit is never a success by itself: text the model wrote beside a
  // tool call is scratch. One request with tools off asks for the answer,
  // when the profile's finalizer covers this exit (the step limit, or the
  // deadline reserve), prose can satisfy the runtime's completion contract
  // and there is time left to write it.
  const finalizerExit =
    loop.stop.reason === "max-steps" && profile.finalizer.maxSteps
      ? ("max-steps" as const)
      : reserveReached
        ? ("deadline" as const)
        : undefined;
  if (finalizerExit && finalizerEligible()) {
    loop.enter("finalizing");
    const answer = await runFinalizer(loop.steps + 1);
    if (answer) {
      finalContent =
        steeredProse.length > 0
          ? [...steeredProse, answer].join("\n\n")
          : answer;
      loop.stop = { reason: finalizerExit, finalizer: true };
    }
  }
  loop.enter("stopped");
  await stepEvents.close(loop.stop.reason);

  budget.assertLive();
  return {
    finalContent,
    finalToolOutput,
    collectedToolCalls,
    executedToolCalls,
    failedToolCalls,
    pendingProposals,
    emittedEvents,
    streamDeltaCount: delta.count(),
    stop: loop.stop,
    ...(stopMessage ? { stopMessage } : {}),
    effectiveMaxSteps,
    deadline: budget.deadline,
    // Judged here, where every way out of the loop ends — a text answer,
    // `runtime-done`, a completing tool, a hook that stops the loop, or the
    // step limit — so none of them can pass a runtime that did no work.
    requiredToolUseUnmet:
      requireToolUse &&
      !hasBusinessWork(manifest, executedToolCalls, seededBusinessWork),
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

/** Ask for the answer `answerPrompt` names, tools off. */
function answerWithoutTools(
  answerPrompt: ResolvedLoopProfile["answerPrompt"],
  locale: string | undefined,
): LLMMessage {
  return answerPrompt === "story"
    ? writeStoryWithoutTools(locale)
    : finalAnswerWithoutTools(locale);
}

/** Ask a non-story runtime at its step limit for its final answer, tools off. */
function finalAnswerWithoutTools(locale: string | undefined): LLMMessage {
  return {
    role: "system",
    content:
      instructionLocaleFor(locale) === "zh"
        ? "已经没有剩余步数，工具已关闭。现在根据已有的信息直接给出最终答案，按要求的输出格式回复；不要再调用工具或解释处理过程。"
        : "No steps are left and tools are off. Give your final answer now from the information you already have, in the required output format. Do not call tools or describe the processing steps.",
  };
}

/** Ask a story runtime that has only called tools to write the narrative. */
function writeStoryWithoutTools(locale: string | undefined): LLMMessage {
  return {
    role: "system",
    content:
      instructionLocaleFor(locale) === "zh"
        ? "你只完成了工具调用，还没有输出故事正文。现在根据已读取的信息直接写出本回合正文；不要再调用工具或解释处理过程。"
        : "You completed tool calls but have not written the story. Write this turn's narrative now using the information already retrieved. Do not call more tools or describe the processing steps.",
  };
}
