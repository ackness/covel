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
import { pluginMessagesFor, toJsonValueOrDiagnostic } from "@covel/shared";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import {
  isSuspendSentinel,
  parseJsonText,
  type EmittedEvent,
} from "@covel/tools";
import type {
  LLMMessage,
  LLMResponse,
  LLMToolCall,
  LLMToolDefinition,
} from "@covel/shared";
import type { SuspendedLoopState } from "@covel/store";
import { promptCacheKeyFor } from "../llm/prompt-cache-key.js";
import type { HookPipeline } from "../hooks/pipeline.js";
import type { RetryInfo } from "../retry/llm-retry.js";
import { buildAgentLoopPolicy } from "./agent-loop-policy.js";
import type { ToolCallContext } from "./tool-executor.js";
import { submitOutputPrompt } from "./loop-prompts.js";
import {
  evaluateSubmission,
  rejectOutput,
  type OutputRejection,
} from "./output-submission.js";
import { renderToolError, renderToolSuccess } from "./tool-result-text.js";
import {
  MAX_PARALLEL_TOOL_CALLS,
  runBounded,
  cutToolStep,
  closeUnansweredToolCalls,
  emitSkippedToolCall,
} from "./tool-batch.js";
import {
  ContextOverflowError,
  prepareBudgetedRequest,
} from "./request-context-budget.js";
import {
  createLoopContextPolicy,
  hasToolStepGroup,
} from "./loop-context-policy.js";
import { createDeltaForwarder } from "./delta-forwarder.js";
import {
  deferredToolDefinitions,
  executeToolSearch,
  SEARCH_TOOLS_TOOL_NAME,
} from "./tool-search.js";
import { requestLLMResponse } from "./tool-loop-handler.js";
import {
  createPictureLoader,
  hasPictureAttachments,
  inlinePictureAttachments,
  withoutPictureAttachments,
} from "./picture-attachments.js";
import { handleSuspension } from "../resume/suspend-resume-handler.js";
import { createCorrectionPolicy } from "./correction-policy.js";
import { guardAgainstToolLoop } from "./loop-detection.js";
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
  type ExecutedToolCallState,
  type FailedToolCallState,
} from "../turn-executor/turn-output-helpers.js";
import {
  buildAssistantToolCallMessage,
  buildPreToolAbortMessage,
  buildToolExecutionUnavailableMessage,
  buildToolResultMessage,
  buildSuspendedPlaceholderMessage,
  buildNestedSuspendMessage,
} from "./turn-agent-tool-loop-messages.js";
import type { AgentLoopDeps } from "../turn-executor/turn-executor-types.js";
import {
  hasBusinessWork,
  captureBusinessCalls,
  unresolvedToolFailures,
  type BusinessCalls,
} from "./runtime-completion.js";
import {
  DEFAULT_PROTECT_LAST_USER_TURNS,
  type BudgetOptions,
  type TokenEstimator,
} from "@covel/context";

export interface AgentToolLoopCompleted {
  /** Kernel-owned, schema-validated model output. Never a tool effect. */
  readonly acceptedOutput: Readonly<Record<string, unknown>> | null;
  readonly collectedToolCalls: ToolCallRecord[];
  readonly executedToolCalls: ExecutedToolCallState[];
  readonly failedToolCalls: FailedToolCallState[];
  readonly pendingProposals: Proposal[];
  /** Domain events emitted via `emit-event` tool calls this loop — merged into `effects.events` at finalize. */
  readonly emittedEvents: EmittedEvent[];
  readonly streamDeltaCount: number;
  /** How the loop ended. */
  readonly stop: LoopStop;
  /** The PreStep cancellation message or the context overflow text. */
  readonly stopMessage?: string;
  /** The configured step limit; a PreStep hook may have lowered the one used. */
  readonly effectiveMaxSteps: number;
  readonly deadline: number;
  /** Required business tool work is still missing after the corrective step. */
  readonly requiredToolUseUnmet: boolean;
  readonly lastTarget?: LLMTargetIdentity;
}

export type AgentToolLoopResult = AgentToolLoopCompleted | RuntimeResult;

/** Mid-loop state restored from a suspension; omitted for a fresh loop. */
export interface AgentToolLoopInitialState {
  readonly businessCalls?: BusinessCalls;
  readonly collectedToolCalls?: readonly ToolCallRecord[];
  readonly pendingProposals?: readonly Proposal[];
  readonly emittedEvents?: readonly EmittedEvent[];
  /** Admitted output contract, spent budgets and activated tools. */
  readonly loop?: SuspendedLoopState;
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
  /**
   * Passed to `PreLLMCall` hooks. On resume nothing is assembled: the list
   * saved with the suspension is passed again.
   */
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
  /** Progress scope of a nested call, persisted if this loop suspends. */
  readonly progressScopeId?: string;
  /** Seed mid-turn state — used by the resume path. Omitted = fresh loop. */
  readonly initialState?: AgentToolLoopInitialState;
  /**
   * Whether a suspend sentinel may suspend this loop. Dispatch and resume
   * allow it (`true`, default), so a resumed runtime can suspend again; a
   * sub-agent cannot, and gets an unavailable tool result instead.
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
    const stop = classifyLoopError(
      error,
      budget,
      options.deps.turnControl,
      options.runId,
    );
    let thrown = error;
    try {
      budget.assertLive();
    } catch (abort) {
      thrown = abort;
    }
    if (stop) tagStop(thrown, stop, options.runId);
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
    progressScopeId,
    initialState,
    allowSuspend = true,
  }: RunAgentToolLoopOptions,
  budget: ReturnType<typeof createAgentLoopBudget>,
  stepEvents: StepRecorder,
): Promise<AgentToolLoopResult> {
  let acceptedOutput: Readonly<Record<string, unknown>> | null = null;
  let lastTarget: LLMTargetIdentity | undefined;
  const collectedToolCalls: ToolCallRecord[] = [
    ...(initialState?.collectedToolCalls ?? []),
  ];
  const executedToolCalls: ExecutedToolCallState[] = (
    initialState?.businessCalls ?? []
  ).map((call) => ({
    name: call.name,
    arguments: "",
    success: call.success,
    result: structuredClone(call.result),
  }));
  // A failure still unresolved at the suspension stays visible to the
  // finalizer, as it would have without the suspension.
  const failedToolCalls: FailedToolCallState[] = unresolvedToolFailures(
    initialState?.businessCalls,
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
  // Set by a PreStep cancellation or a request that cannot fit.
  let stopMessage: string | undefined;

  // The policy owns tool surfaces, model settings, and execution budgets.
  const {
    toolDefs,
    output,
    deferredToolNames,
    responseFormat,
    runtimeModelOverride,
    useStreaming,
    effectiveMaxSteps: configuredMaxSteps,
    retryPolicy,
    requireToolUse,
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
  // Corrections bound one logical runtime, so a resumed loop keeps the
  // counts it spent before its suspension.
  const correctionLimits = { ...profile.corrections };
  for (const kind of Object.keys(
    correctionLimits,
  ) as (keyof typeof correctionLimits)[]) {
    correctionLimits[kind] = Math.min(
      correctionLimits[kind],
      initialState?.loop?.correctionLimits[kind] ?? correctionLimits[kind],
    );
  }
  const policy = createCorrectionPolicy(
    correctionLimits,
    initialState?.loop?.corrections,
  );
  // The step limit in force. A PreStep hook may lower it, never raise it.
  const effectiveMaxSteps = Math.min(
    configuredMaxSteps,
    initialState?.loop?.maxSteps ?? configuredMaxSteps,
  );
  let stepLimit = effectiveMaxSteps;
  loop.steps = initialState?.loop?.steps ?? 0;

  // search-tools can activate deferred tools for subsequent steps. A resumed
  // loop starts with the ones it had activated before its suspension.
  const restoredTools =
    initialState?.loop?.activatedTools && deps.toolExecutor
      ? deferredToolDefinitions(
          initialState.loop.activatedTools.filter(
            (name) => !toolDefs?.some((definition) => definition.name === name),
          ),
          deferredToolNames,
          deps.toolExecutor,
          {
            sessionId: input.sessionId,
            turnId: input.turnId,
            pluginId: manifest.pluginId,
            runtimeId: manifest.name,
          },
        )
      : [];
  let activeToolDefs =
    restoredTools.length > 0
      ? [...(toolDefs ?? []), ...restoredTools]
      : toolDefs;

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
  const projectToolRecord = (record: import("@covel/shared").ToolCallRecord) =>
    deps.delegation?.privacy.record(record) ?? record;
  const toolCallContext = (): ToolCallContext => ({
    delegation: deps.delegation,
    playerActions: input.actions ?? [],
    sessionId: input.sessionId,
    turnId: input.turnId,
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    locale: input.locale,
    messages: pluginMessagesFor(loaded.messages, input.locale),
    pendingProposals,
    ...(pluginDataVisibility ? { pluginDataVisibility } : {}),
    upstreamProposals,
    world,
    signal: hookOpts.signal,
    inputSlots,
    emittedEventTopics: emittedEvents.map((event) => event.topic),
    emitter: deps.emitter,
    ...(turnNumber !== undefined ? { turnNumber } : {}),
    ...(logicalTurn !== undefined ? { logicalTurn } : {}),
    authorizedToolNames,
  });
  let terminatedByHook = false;
  const reviewResponse = createResponseReviewer(hookOpts);
  const loopContextPolicy = createLoopContextPolicy({ locale: input.locale });
  const pictureLoader = createPictureLoader(deps.mediaStore, input.sessionId);
  // A player's interjection is one more user message of the current turn.
  let currentTurnUserMessages = initialTurnUserMessages;
  // The correction asked for a tool call; the next request requires one.
  let toolCallRequested = false;
  let submissionOnly = false;
  let rejection: OutputRejection | undefined;
  let rejectionAttempts = initialState?.loop?.rejectionAttempts ?? 0;
  const requiredWorkMet = (): boolean =>
    !requireToolUse ||
    (hasBusinessWork(manifest, executedToolCalls) &&
      unresolvedToolFailures(executedToolCalls).length === 0);

  /**
   * One model request: PreLLMCall, pictures, the context budget, then the
   * provider call. Shared by every step and the finalizer.
   */
  const callModel = async (step: {
    readonly tools: readonly LLMToolDefinition[] | undefined;
    readonly toolChoice?: StepToolChoice;
    readonly requireToolCall: boolean;
    readonly submissionRequested: boolean;
    readonly submissionOnly?: boolean;
    readonly trim?: "normal" | "emergency";
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
    let hookedRequest = await runPreLLMCallHook(hookOpts, {
      messages,
      model: effectiveModel,
      tools: step.tools,
      ...(promptSegments ? { promptSegments } : {}),
    });
    // The reserve/fallback request cannot regain business tools through a hook.
    if (step.submissionOnly)
      hookedRequest = {
        ...hookedRequest,
        tools: toolDefs.filter((tool) => tool.name === output.toolName),
      };
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
    const budgetedRequest = await tagging(runId, "context-overflow", () =>
      prepareBudgetedRequest({
        loopPolicy: loopContextPolicy,
        trim: step.trim,
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

    if (loop.phase === "awaiting-pre-step") loop.enter("requesting-model");
    budget.pauseForModel();
    let rawResponse: Awaited<ReturnType<typeof requestLLMResponse>>;
    try {
      rawResponse = await tagging(runId, "model-error", () =>
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
          allowTruncatedText: false,
          requireToolCall: step.requireToolCall,
          submissionRequested: step.submissionRequested,
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

  /** Trace and record the control lifecycle without promoting it into business effects. */
  const recordControlCall = async (
    call: LLMToolCall,
    evaluate: () => Promise<{
      candidate?: Readonly<Record<string, unknown>>;
      rejection?: OutputRejection;
    }>,
    postHook = true,
  ) => {
    const started = Date.now();
    const identity = {
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      toolName: call.name,
      toolCallId: call.id,
      label: `${manifest.pluginId}/${call.name}`,
      approvalStatus: "auto-allowed",
    };
    const emit = async (
      type: "tool.calling" | "tool.completed" | "tool.failed",
      extra: Record<string, unknown>,
    ) => {
      try {
        await deps.emitter?.emit(type, { ...identity, ...extra });
      } catch {
        console.warn("[agent-loop] control tool trace delivery failed");
      }
    };
    await emit("tool.calling", {
      arguments: call.arguments,
      source: "builtin",
    });
    let evaluated: Awaited<ReturnType<typeof evaluate>>;
    try {
      evaluated = await evaluate();
    } catch (error) {
      const message = "Output review could not complete.";
      const content = renderToolError({ code: "internal", message });
      try {
        if (postHook)
          await runPostToolUseHook(hookOpts, call, {
            toolCallId: call.id,
            name: call.name,
            result: content,
            success: false,
            error: { code: "internal", message },
            approvalStatus: "auto-allowed",
          });
      } finally {
        await emit("tool.failed", {
          success: false,
          code: "internal",
          error: message,
          durationMs: Date.now() - started,
        });
        messages.push(buildToolResultMessage({ toolCallId: call.id, content }));
        stepEvents.toolCall(call.name, false);
      }
      throw error;
    }
    const steering: string[] = [];
    const supersede = () => {
      if (!evaluated.candidate || !profile.steering) return;
      steering.push(...(deps.turnControl?.drainSteering?.() ?? []));
      if (steering.length)
        evaluated = {
          rejection: rejectOutput(
            "invalid-output",
            "Submission superseded by new player input. Read it and submit again.",
            "superseded",
          ),
        };
    };
    supersede();
    budget.assertLive();
    let error = evaluated.rejection && {
      code: evaluated.rejection.code,
      message: evaluated.rejection.message,
    };
    let resultText = error
      ? renderToolError(error)
      : renderToolSuccess({
          model: { summary: "Output accepted. Changes are not yet committed." },
        });
    const originalResult = {
      toolCallId: call.id,
      name: call.name,
      result: resultText,
      parsedResult: JSON.parse(resultText) as unknown,
      success: !error,
      ...(error ? { error } : {}),
      approvalStatus: "auto-allowed" as const,
    };
    const post = postHook
      ? await runPostToolUseHook(hookOpts, call, originalResult)
      : { result: originalResult, terminate: false };
    budget.assertLive();
    if (post.terminate) terminatedByHook = true;
    supersede();
    if (evaluated.rejection && !error) {
      error = {
        code: evaluated.rejection.code,
        message: evaluated.rejection.message,
      };
      resultText = renderToolError(error);
    }
    if (evaluated.candidate) acceptedOutput = evaluated.candidate;
    const durationMs = Date.now() - started;
    await emit(error ? "tool.failed" : "tool.completed", {
      success: !error,
      durationMs,
      ...(error
        ? { code: error.code, error: error.message }
        : { result: resultText, parsedResult: originalResult.parsedResult }),
    });
    let parsedInput: unknown = {};
    try {
      parsedInput = JSON.parse(call.arguments);
    } catch {
      /* invalid JSON has no parsed input */
    }
    collectedToolCalls.push(
      projectToolRecord({
        toolCallId: call.id,
        toolName: call.name,
        pluginId: manifest.pluginId,
        runtimeId: manifest.name,
        turnId: input.turnId,
        input: toJsonValueOrDiagnostic(parsedInput, "input"),
        output: toJsonValueOrDiagnostic(
          JSON.parse(resultText) as unknown,
          "output",
        ),
        durationMs,
        approvalStatus: "auto-allowed",
        timestamp: new Date().toISOString(),
      }),
    );
    stepEvents.toolCall(call.name, !error);
    messages.push(
      buildToolResultMessage({
        toolCallId: call.id,
        content:
          evaluated.rejection?.reason === "superseded" ||
          typeof post.result.result !== "string"
            ? resultText
            : post.result.result,
      }),
    );
    if (steering.length) {
      for (const steer of steering) {
        messages.push({ role: "user", content: steer });
        currentTurnUserMessages++;
      }
      stepEvents.note({ kind: "late-steering", count: steering.length });
    }
    return evaluated;
  };
  const recordSkipped = async (call: LLMToolCall, reason: string) => {
    const message = buildPreToolAbortMessage({ toolCallId: call.id, reason });
    messages.push(message);
    await emitSkippedToolCall({
      call,
      context: toolCallContext(),
      reason: "hook-aborted",
      message,
    });
  };

  const processResponse = async (
    rawResponse: LLMResponse,
    reviewMessages: readonly LLMMessage[],
    submissionOnly: boolean,
  ): Promise<RuntimeResult | undefined> => {
    rejection = undefined;
    const assistantMessageIndex = messages.length;
    // Store the actual provider message, never a synthesized content-only review.
    messages.push(buildAssistantToolCallMessage(rawResponse));
    const reviewed = await tagging(runId, "invalid-output", () =>
      reviewResponse(rawResponse, reviewMessages),
    );
    budget.assertLive();
    if (reviewed.correction) {
      rejection = rejectOutput("review-rejected", reviewed.correction);
      for (const call of rawResponse.toolCalls)
        await recordControlCall(
          call,
          async () => ({ rejection: rejection! }),
          false,
        );
      if (!rawResponse.toolCalls.length)
        messages.push({ role: "system", content: rejection.message });
      return;
    }
    const response = reviewed.response;
    if (!response.toolCalls.length) {
      rejection = rejectOutput(
        "invalid-output",
        submitOutputPrompt(input.locale).content as string,
        "missing-submission",
      );
      messages.push(submitOutputPrompt(input.locale));
      return;
    }
    toolCallRequested = false;
    await delta.reset();
    const preOutcomes = new Map<
      number,
      Awaited<ReturnType<typeof runPreToolUseHook>>
    >();
    const effectiveCalls = new Map<number, LLMToolCall | null>();
    const hookAborts = new Map<string, string>();
    const startedCallIds = new Set<string>();
    const prepareCall = async (index: number) => {
      if (preOutcomes.has(index)) return;
      budget.assertLive();
      const call = response.toolCalls[index]!;
      const outcome = await runPreToolUseHook(hookOpts, call);
      preOutcomes.set(index, outcome);
      effectiveCalls.set(index, outcome.skipped ? null : outcome.toolCall);
      if (outcome.skipped) {
        hookAborts.set(call.id, outcome.reason);
      }

      budget.assertLive();
    };

    // All names must be known before any sibling can write. Hooks run once,
    // in provider order, and dispatch below reuses these outcomes.
    for (let index = 0; index < response.toolCalls.length; index++)
      await prepareCall(index);
    const originalSubmission = rawResponse.toolCalls.some(
      (call) => call.name === output.toolName,
    );
    const effectiveSubmission = [...effectiveCalls.values()].some(
      (call) => call?.name === output.toolName,
    );
    const badBatch =
      (response.toolCalls.length > 1 &&
        (originalSubmission || effectiveSubmission)) ||
      (submissionOnly &&
        response.toolCalls.some(
          (_, index) => effectiveCalls.get(index)?.name !== output.toolName,
        ));
    if (badBatch) {
      rejection = rejectOutput(
        "submission-batch",
        "Call submit-output alone, without sibling calls. None of this batch's tools ran.",
      );
      for (const [index, call] of rawResponse.toolCalls.entries()) {
        const outcome = preOutcomes.get(index)!;
        if (outcome.skipped) await recordSkipped(call, outcome.reason);
        else
          await recordControlCall(
            outcome.toolCall,
            async () => ({ rejection: rejection! }),
            call.name === output.toolName ||
              outcome.toolCall.name === output.toolName,
          );
      }
      return;
    }
    const soleCall = response.toolCalls[0];
    const soleOutcome = preOutcomes.get(0);
    if (
      soleCall &&
      soleOutcome &&
      !soleOutcome.skipped &&
      soleOutcome.toolCall.name === output.toolName
    ) {
      const evaluated = await recordControlCall(soleOutcome.toolCall, () =>
        evaluateSubmission({
          contract: output,
          manifest,
          call: soleOutcome.toolCall,
          originalCall: rawResponse.toolCalls[0]!,
          requiredWorkMet: requiredWorkMet(),
          publicToolResults: collectedToolCalls.map(projectToolRecord),
          hookOpts,
          locale: input.locale,
        }),
      );
      budget.assertLive();
      if (evaluated.rejection) rejection = evaluated.rejection;
      else if (evaluated.candidate) acceptedOutput = evaluated.candidate;
      return;
    }
    try {
      let nextCall = 0;
      while (nextCall < response.toolCalls.length) {
        budget.assertLive();
        const executor = deps.toolExecutor;
        if (!executor) {
          messages.push(
            buildToolExecutionUnavailableMessage(
              response.toolCalls[nextCall++]!.id,
            ),
          );
          continue;
        }
        // This snapshot is shared by classification and execution for the step.
        const context = toolCallContext();
        const poolable = (call: LLMToolCall) => {
          if (
            !authorizedToolNames.has(call.name) ||
            [
              SEARCH_TOOLS_TOOL_NAME,
              "suspend",
              "submit-output",
              "delegate",
              "delegate-batch",
            ].includes(call.name)
          )
            return false;
          const info = executor.getToolInfo(call.name, context);
          return (
            info?.annotations.readOnly === true &&
            info.annotations.concurrencySafe === true
          );
        };
        await prepareCall(nextCall);
        let step = cutToolStep(
          response.toolCalls,
          nextCall,
          poolable,
          effectiveCalls,
        );
        for (const index of step.indices.slice(1)) {
          await prepareCall(index);
          step = cutToolStep(
            response.toolCalls,
            nextCall,
            poolable,
            effectiveCalls,
          );
          if (!step.indices.includes(index)) break;
        }

        // Hooks are prepared in order; tool work alone runs concurrently.
        const results = await runBounded(
          step.indices.map((index) => async () => {
            budget.assertLive();
            const outcome = preOutcomes.get(index)!;
            if (outcome.skipped) return null;
            const effectiveTc = outcome.toolCall;
            if (
              effectiveTc.name === SEARCH_TOOLS_TOOL_NAME &&
              deferredToolNames.size > 0
            )
              return null;
            const started = Date.now();
            startedCallIds.add(effectiveTc.id);
            const result = await executor.execute(
              {
                toolCallId: effectiveTc.id,
                name: effectiveTc.name,
                arguments: effectiveTc.arguments,
              },
              context,
            );
            return { result, durationMs: Date.now() - started };
          }),
          step.kind === "pool" ? MAX_PARALLEL_TOOL_CALLS : 1,
        );
        budget.assertLive();

        for (const [position, toolCallIndex] of step.indices.entries()) {
          const tc = response.toolCalls[toolCallIndex]!;
          const outcome = preOutcomes.get(toolCallIndex)!;
          if (outcome.skipped) {
            const message = buildPreToolAbortMessage({
              toolCallId: tc.id,
              reason: outcome.reason,
            });
            messages.push(message);
            await emitSkippedToolCall({
              call: tc,
              context,
              reason: "hook-aborted",
              message,
            });
            continue;
          }
          const effectiveTc = outcome.toolCall;
          const tcStart = Date.now();
          // ── search-tools interception (deferred tool loading) ─
          // Framework-injected sentinel, same pattern as suspend /
          // submit-output: never dispatched to the executor. Ranks the
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
              context,
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
            collectedToolCalls.push(
              projectToolRecord({
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
              }),
            );
            continue;
          }

          const { result, durationMs } = results[position]!;
          const { result: toolResult, terminate: terminateAfterTool } =
            await runPostToolUseHook(hookOpts, effectiveTc, result);
          budget.assertLive();
          if (!toolResult.success && !toolResult.refused) {
            failedToolCalls.push({
              toolName: effectiveTc.name,
              message: extractToolFailureMessage(toolResult.result),
            });
          }
          if (toolResult.pendingProposals?.length)
            pendingProposals.push(...toolResult.pendingProposals);
          if (toolResult.emittedEvents?.length)
            emittedEvents.push(...toolResult.emittedEvents);

          // ── Suspend detection ────────────────────────
          // These names are reserved to builtins by ToolRegistry. A matching
          // field from a plugin tool is ordinary data, not loop control.
          // When the suspend tool is called, capture the current loop state as
          // an execution-local artifact. The tool result is not pushed back to
          // the LLM; instead we exit the loop with status 'suspended'. A
          // resumed loop suspends the same way.
          //
          // A sub-agent runs with `allowSuspend: false`: it cannot suspend, so
          // the sentinel is fed back to the LLM as an error tool result and
          // the loop continues.
          if (
            effectiveTc.name === "suspend" &&
            toolResult.success &&
            isSuspendSentinel(toolResult.parsedResult)
          ) {
            if (!allowSuspend) {
              messages.push(buildNestedSuspendMessage(effectiveTc.id));
              continue;
            }
            {
              // The captured assistant message contains the whole tool-call
              // batch. Provider protocols require a tool-role result for every
              // call before the next LLM request. Capture a placeholder for the
              // suspender (resume replaces its content) and explicitly cancel
              // later calls rather than leaving dangling ids in the transcript.
              messages.push(buildSuspendedPlaceholderMessage(effectiveTc.id));
              await closeUnansweredToolCalls({
                messages,
                assistantMessageIndex,
                context,
                reason: "suspended",
                hookAborts,
              });
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
                collectedToolCalls,
                businessCalls: captureBusinessCalls(executedToolCalls),
                pendingProposals,
                emittedEvents,
                executionContext,
                ...(progressScopeId !== undefined ? { progressScopeId } : {}),
                ...(logicalTurn !== undefined ? { logicalTurn } : {}),
                ...(turnNumber !== undefined ? { turnNumber } : {}),
                currentTurnUserMessages,
                suspendToolCallId: effectiveTc.id,
                startTime,
                runId,
                loop: {
                  corrections: policy.snapshot(),
                  activatedTools: (activeToolDefs ?? [])
                    .map((definition) => definition.name)
                    .filter(
                      (name) =>
                        !toolDefs?.some((initial) => initial.name === name),
                    ),
                  steps: loop.steps,
                  maxSteps: stepLimit,
                  rejectionAttempts,
                  correctionLimits,
                  outputContract: {
                    toolName: output.toolName,
                    schema: output.schema,
                    schemaSource: output.schemaSource,
                    provenance: output.provenance,
                    requiredWork: output.requiredWork,
                  },
                },
                ...(promptSegments ? { promptSegments } : {}),
              });
            }
          }

          executedToolCalls.push({
            name: effectiveTc.name,
            arguments: effectiveTc.arguments,
            result: result.parsedResult,
            success: result.success,
            ...(result.refused ? { refused: true as const } : {}),
          });
          stepEvents.toolCall(effectiveTc.name, toolResult.success);

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
          collectedToolCalls.push(
            projectToolRecord({
              toolCallId: effectiveTc.id,
              toolName: effectiveTc.name,
              pluginId: manifest.pluginId,
              runtimeId: manifest.name,
              turnId: input.turnId,
              input: toJsonValueOrDiagnostic(parsedInput, "input"),
              output: toJsonValueOrDiagnostic(
                toolResult.parsedResult,
                "output",
              ),
              durationMs,
              approvalStatus: toolResult.approvalStatus ?? "auto-allowed",
              timestamp: new Date().toISOString(),
            }),
          );

          messages.push(
            buildToolResultMessage({
              toolCallId: effectiveTc.id,
              content: toolResult.result,
            }),
          );

          if (terminateAfterTool) terminatedByHook = true;
        }
        nextCall = step.indices.at(-1)! + 1;
        if (terminatedByHook) break;
      }
      if (terminatedByHook) {
        await closeUnansweredToolCalls({
          messages,
          assistantMessageIndex,
          context: toolCallContext(),
          reason: "terminated",
          hookAborts,
        });
      }
    } catch (error) {
      await closeUnansweredToolCalls({
        messages,
        assistantMessageIndex,
        context: toolCallContext(),
        reason: "aborted",
        hookAborts,
        startedCallIds,
      });
      // Runtime cancellation or deadline takes precedence over a task rejection.
      budget.assertLive();
      throw error;
    }

    if (terminatedByHook) return;
    const perturbationsBefore = policy.used("loopPerturbation");
    try {
      guardAgainstToolLoop({
        collectedToolCalls: collectedToolCalls.filter(
          (call) => call.toolName !== output.toolName,
        ),
        threshold: retryPolicy.loopDetectionThreshold,
        runtimeName: manifest.name,
        messages,
        policy,
        locale: input.locale,
      });
    } catch (error) {
      if (
        profile.fallback !== "submit-output" ||
        submissionOnly ||
        !requiredWorkMet()
      ) {
        tagStop(error, { reason: "loop-detected" }, runId);
        throw error;
      }
      // The caller makes the next ordinary step submission-only.
      forceSubmissionOnly = true;
      messages.push(submitOutputPrompt(input.locale));
      stepEvents.note({ kind: "submission-only" });
    }
    if (policy.used("loopPerturbation") > perturbationsBefore)
      stepEvents.note({ kind: "loop-perturbation" });
  };
  let forceSubmissionOnly = false;
  const finalizerEligible = (): boolean =>
    requiredWorkMet() &&
    budget.deadline - Date.now() >= FINALIZER_MIN_REMAINING_MS;
  const deadlineReserveMs = Math.min(
    profile.finalizer.deadlineReserveMs,
    Math.floor(timeoutMs / 2),
  );
  let reserveReached = false;

  while (loop.steps < stepLimit && Date.now() < budget.deadline) {
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
    loop.enter("awaiting-pre-step");
    budget.assertLive();
    await stepEvents.close();
    if (profile.steering)
      for (const steer of deps.turnControl?.drainSteering?.() ?? []) {
        messages.push({ role: "user", content: steer });
        currentTurnUserMessages++;
      }
    submissionOnly ||= forceSubmissionOnly;
    const offered = submissionOnly
      ? toolDefs.filter((tool) => tool.name === output.toolName)
      : activeToolDefs;
    const toolNames = (offered ?? []).map((tool) => tool.name);
    const submissionRequested =
      submissionOnly ||
      (toolCallRequested && rejection?.correction !== "toolUse") ||
      (requiredWorkMet() &&
        (requireToolUse ||
          toolNames.every((name) => name === output.toolName)));
    const loopToolChoice: StepToolChoice = submissionOnly
      ? { name: output.toolName }
      : toolCallRequested
        ? rejection?.correction === "toolUse"
          ? "required"
          : { name: output.toolName }
        : (manifest.llm?.toolChoice ?? "auto");
    const preStep = await runPreStepHook(hookOpts, {
      step: loop.steps,
      stepsRemaining: stepLimit - loop.steps + 1,
      maxSteps: stepLimit,
      toolNames,
      toolChoice: loopToolChoice,
    });
    if (preStep.tools || preStep.ignoredTools > 0)
      stepEvents.note({
        kind: "tool-narrowed",
        count: (preStep.tools ?? toolNames).length,
        ...(preStep.ignoredTools ? { ignored: preStep.ignoredTools } : {}),
      });
    if (preStep.stop) {
      loop.stop =
        preStep.stop.reason === "cancelled"
          ? { reason: "cancelled", cancelledBy: "hook" }
          : { reason: "invalid-output" };
      stopMessage =
        preStep.stop.message ?? "Loop stopped without an accepted submission.";
      break;
    }
    if (preStep.stepsRemaining !== undefined)
      stepLimit = Math.min(stepLimit, loop.steps + preStep.stepsRemaining - 1);
    const stepTools = preStep.tools
      ? offered?.filter((tool) => preStep.tools!.includes(tool.name))
      : offered;
    const toolChoice = submissionOnly
      ? { name: output.toolName }
      : (preStep.toolChoice ?? loopToolChoice);
    await stepEvents.start({
      step: loop.steps,
      maxSteps: stepLimit,
      toolCount: stepTools?.length ?? 0,
      toolChoice,
    });
    let modelCall: Awaited<ReturnType<typeof callModel>>;
    try {
      modelCall = await callModel({
        tools: stepTools,
        toolChoice,
        requireToolCall: toolCallRequested || submissionOnly,
        submissionRequested,
        submissionOnly,
      });
    } catch (error) {
      if (
        !(error instanceof ContextOverflowError) ||
        error.kind !== "over-limit"
      )
        throw error;
      loop.stop = { reason: "context-overflow" };
      stopMessage = error.message;
      await stepEvents.close(loop.stop.reason);
      break;
    }
    lastTarget = modelCall.rawResponse.target;
    loop.enter("reviewing");
    loop.enter("running-tools");
    const suspended = await processResponse(
      modelCall.rawResponse,
      modelCall.reviewMessages,
      submissionOnly,
    );
    if (suspended) return suspended;
    loop.enter("deciding");
    budget.assertLive();
    if (acceptedOutput) {
      loop.stop = { reason: "completed" };
      break;
    }
    if (rejection) {
      stepEvents.note({
        kind: "output-rejected",
        reason: rejection.reason,
        attempt: ++rejectionAttempts,
      });
      stopMessage = `Output rejected (${rejection.reason}).`;
      // An exhausted category is terminal even when another counter has room.
      if (
        terminatedByHook ||
        (rejection.correction && !policy.canTake(rejection.correction))
      ) {
        loop.stop = { reason: "invalid-output" };
        break;
      }
      // Spend only when scheduling a subsequent request. The reserve step, if
      // eligible, charges its correction at its own admission below.
      if (loop.steps < stepLimit && rejection.correction)
        policy.take(rejection.correction);
      toolCallRequested = true;
    } else if (terminatedByHook) {
      loop.stop = { reason: "invalid-output" };
      stopMessage = "Loop stopped without an accepted submission.";
      break;
    }
  }
  loop.stop ??=
    loop.steps >= stepLimit ? { reason: "max-steps" } : { reason: "deadline" };
  const finalizerExit =
    loop.stop.reason === "max-steps" && profile.finalizer.maxSteps
      ? "max-steps"
      : reserveReached
        ? "deadline"
        : loop.stop.reason === "context-overflow" &&
            profile.finalizer.maxSteps &&
            hasToolStepGroup(messages)
          ? "context-overflow"
          : undefined;
  if (finalizerExit && finalizerEligible()) {
    loop.enter("finalizing");
    if (profile.steering)
      for (const steer of deps.turnControl?.drainSteering?.() ?? []) {
        messages.push({ role: "user", content: steer });
        currentTurnUserMessages++;
      }
    if (rejection?.correction && loop.steps >= stepLimit)
      policy.take(rejection.correction);
    messages.push(submitOutputPrompt(input.locale));
    const tools = toolDefs.filter((tool) => tool.name === output.toolName);
    await stepEvents.start({
      step: loop.steps + 1,
      maxSteps: stepLimit,
      toolCount: 1,
      toolChoice: { name: output.toolName },
      finalizer: true,
    });
    try {
      const modelCall = await callModel({
        tools,
        toolChoice: { name: output.toolName },
        requireToolCall: true,
        submissionRequested: true,
        submissionOnly: true,
        trim: "emergency",
      });
      lastTarget = modelCall.rawResponse.target;
      await processResponse(
        modelCall.rawResponse,
        modelCall.reviewMessages,
        true,
      );
      budget.assertLive();
      if (acceptedOutput) {
        loop.stop = { reason: finalizerExit, finalizer: true };
        stopMessage = undefined;
      } else if (rejection) {
        stepEvents.note({
          kind: "output-rejected",
          reason: rejection.reason,
          attempt: ++rejectionAttempts,
        });
        if (
          terminatedByHook ||
          (rejection.correction && !policy.canTake(rejection.correction))
        ) {
          loop.stop = { reason: "invalid-output" };
          stopMessage = `Output rejected (${rejection.reason}).`;
        }
      } else if (terminatedByHook) {
        loop.stop = { reason: "invalid-output" };
        stopMessage = "Loop stopped without an accepted submission.";
      }
    } catch (error) {
      budget.assertLive();
      // Preserve the original overflow when even the smaller request cannot fit.
      // Refusals, cancellation and other real provider failures retain their cause.
      if (
        !(error instanceof ContextOverflowError) ||
        error.kind !== "over-limit"
      )
        throw error;
    }
  }
  loop.enter("stopped");
  await stepEvents.close(loop.stop.reason);
  budget.assertLive();
  return {
    acceptedOutput,
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
    requiredToolUseUnmet: !requiredWorkMet(),
    lastTarget,
  };
}
