import type {
  Proposal,
  RuntimeManifest,
  RuntimeResult,
  ToolCallRecord,
  TurnInput,
} from "@covel/shared";
import type { SuspensionRecord } from "@covel/store";
import { isSuspendSentinel, withPendingProposals } from "@covel/tools";
import type { LLMMessage } from "./llm-adapter.js";
import {
  buildLlmCallingPayload,
  buildLlmRespondedErrorPayload,
  buildLlmRespondedSuccessPayload,
} from "./llm-trace-payload.js";
import {
  runPostLLMResponseHook,
  runPostRuntimeHook,
  runPostToolUseHook,
  runPreLLMCallHook,
  runPreRuntimeHook,
  runPreToolUseHook,
} from "./hooks/wire-helpers.js";
import { emitSubEvent } from "./turn-runtime-helpers.js";
import {
  extractToolFailureMessage,
  findLastStructuredToolOutput,
  findPresentableToolOutput,
  formatToolLoopFailure,
  isRecord,
  parseFinalOutputEnvelope,
  sanitizeStoryNarrativeText,
  shouldSuppressToolLoopNarrative,
  type ExecutedToolCallState,
  type FailedToolCallState,
} from "./turn-output-helpers.js";
import { buildToolDefinitions } from "./turn-executor-helpers.js";
import type { TurnExecutorDeps } from "./turn-executor-types.js";

export interface ResumeSuspendedRuntimeOptions {
  readonly maxSteps?: number;
  readonly timeoutMs?: number;
}

/**
 * Re-enter the LLM tool loop for a suspended runtime.
 *
 * The caller is responsible for auth, runtime lookup, and concurrency checks.
 */
export async function resumeSuspendedRuntime(
  suspension: SuspensionRecord,
  resumeData: unknown,
  manifest: RuntimeManifest,
  deps: TurnExecutorDeps,
  options?: ResumeSuspendedRuntimeOptions,
): Promise<RuntimeResult> {
  const startTime = Date.now();
  const maxSteps = options?.maxSteps ?? 10;
  const timeoutMs = options?.timeoutMs ?? manifest.timeoutMs ?? 60000;
  const runId = crypto.randomUUID();

  const { pendingContinuation } = suspension;
  const hookPipeline = deps.hookPipeline;

  const resumeTurnInput = {
    sessionId: suspension.sessionId,
    turnId: suspension.turnId,
    playerMessage: "",
  };
  if (hookPipeline) {
    const preRtResult = await runPreRuntimeHook({
      pipeline: hookPipeline,
      sessionId: suspension.sessionId,
      turnId: suspension.turnId,
      manifest,
      input: resumeTurnInput as unknown as TurnInput,
      eventBus: deps.eventBus,
      emitter: deps.emitter,
    });
    if (preRtResult.action === "abort") {
      const abortedResult: RuntimeResult = {
        pluginId: manifest.pluginId,
        runtimeId: manifest.name,
        runId,
        turnId: suspension.turnId,
        status: "skipped",
        output: null,
        toolCalls: [],
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
      return runPostRuntimeHook(
        {
          pipeline: hookPipeline,
          sessionId: suspension.sessionId,
          turnId: suspension.turnId,
          pluginId: manifest.pluginId,
          runtimeId: manifest.name,
          eventBus: deps.eventBus,
          emitter: deps.emitter,
        },
        abortedResult,
      );
    }
  }

  const messages: LLMMessage[] = [
    ...(pendingContinuation.messages as LLMMessage[]),
  ];

  if (pendingContinuation.suspendToolCallId) {
    messages.push({
      role: "tool",
      content: JSON.stringify({ resumeData }),
      toolCallId: pendingContinuation.suspendToolCallId,
    });
  } else {
    messages.push({
      role: "user",
      content:
        typeof resumeData === "string"
          ? resumeData
          : JSON.stringify(resumeData),
    });
  }

  const finalizeWithPostRuntime = (
    result: RuntimeResult,
  ): RuntimeResult | Promise<RuntimeResult> =>
    hookPipeline
      ? runPostRuntimeHook(
          {
            pipeline: hookPipeline,
            sessionId: suspension.sessionId,
            turnId: suspension.turnId,
            pluginId: manifest.pluginId,
            runtimeId: manifest.name,
            eventBus: deps.eventBus,
            emitter: deps.emitter,
          },
          result,
        )
      : result;

  const loaded = await deps.loadRuntime(manifest, undefined);
  if (!loaded) {
    return finalizeWithPostRuntime({
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      runId,
      turnId: suspension.turnId,
      status: "failed",
      output: null,
      toolCalls: [],
      durationMs: Date.now() - startTime,
      error: "Runtime not found on resume",
      timestamp: new Date().toISOString(),
    });
  }

  const collectedToolCalls: ToolCallRecord[] = [
    ...(pendingContinuation.toolCallsSoFar as ToolCallRecord[]),
  ];
  const executedToolCalls: ExecutedToolCallState[] = [];
  const failedToolCalls: FailedToolCallState[] = [];
  const pendingProposals: Proposal[] = [
    ...(pendingContinuation.pendingProposals as Proposal[]),
  ];
  let finalContent: string | null = pendingContinuation.partialContent ?? null;
  let steps = 0;
  const deadline = Date.now() + timeoutMs;
  let stoppedWithResponse = false;
  // Set by a PostToolUse hook returning `terminate` — ends the resume loop.
  let terminatedByHook = false;

  const toolContext = {
    sessionId: suspension.sessionId,
    turnId: suspension.turnId,
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
  } as const;
  const toolDefs = deps.toolExecutor
    ? buildToolDefinitions(manifest, deps.toolExecutor, toolContext)
    : undefined;

  // Shared hook wiring reused across the LLM-call and tool-call sites below,
  // mirroring runAgentToolLoop. The resume path must fire the same LLM-boundary
  // (PreLLMCall / PostLLMResponse) and tool (Pre/PostToolUse) hooks as the main
  // loop — otherwise a plugin's handlers are silently skipped for any runtime
  // that happens to suspend-and-resume.
  const hookOpts = {
    pipeline: hookPipeline,
    sessionId: suspension.sessionId,
    turnId: suspension.turnId,
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    eventBus: deps.eventBus,
    emitter: deps.emitter,
  };

  while (steps < maxSteps && Date.now() < deadline) {
    steps++;

    const effectiveModel = deps.resolveModel
      ? deps.resolveModel(manifest, undefined)
      : manifest.model;

    // ── PreLLMCall hook ──────────────────────────────────────────
    // Non-destructively rewrite the request sent on THIS call (messages /
    // model / tools) without mutating the canonical transcript — mirrors the
    // main agent loop so a suspended-then-resumed runtime honours the same
    // PreLLMCall handlers (model routing, request audit, token budgeting).
    const llmRequest = await runPreLLMCallHook(hookOpts, {
      messages,
      model: effectiveModel,
      tools: toolDefs,
    });

    const llmCallStart = Date.now();
    if (deps.emitter) {
      await deps.emitter.emit(
        "llm.calling",
        buildLlmCallingPayload({
          runtimeId: manifest.name,
          pluginId: manifest.pluginId,
          slot: llmRequest.model,
          model: llmRequest.model,
          provider: null,
          messages: llmRequest.messages,
          tools: llmRequest.tools,
          attempt: 0,
        }),
      );
    }
    let response;
    try {
      response = await deps.llm.generate({
        model: llmRequest.model,
        messages: llmRequest.messages,
        tools: llmRequest.tools,
        signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
      });
    } catch (err) {
      if (deps.emitter) {
        await deps.emitter.emit(
          "llm.responded",
          buildLlmRespondedErrorPayload({
            runtimeId: manifest.name,
            pluginId: manifest.pluginId,
            error: err,
            durationMs: Date.now() - llmCallStart,
            attempt: 0,
          }),
        );
      }
      throw err;
    }
    if (deps.emitter) {
      await deps.emitter.emit(
        "llm.responded",
        buildLlmRespondedSuccessPayload({
          runtimeId: manifest.name,
          pluginId: manifest.pluginId,
          response,
          durationMs: Date.now() - llmCallStart,
          attempt: 0,
        }),
      );
    }

    // ── PostLLMResponse hook ─────────────────────────────────────
    // Inspect / patch the response (content, toolCalls) before tool dispatch,
    // mirroring the main loop. The trace above records the raw response; the
    // hook shapes what the resume loop actually dispatches on.
    response = await runPostLLMResponseHook(hookOpts, response);

    if (response.toolCalls.length > 0) {
      if (response.content) finalContent = response.content;

      messages.push({
        role: "assistant",
        content: response.content ?? "",
        toolCalls: response.toolCalls,
        ...(response.reasoningContent
          ? { reasoningContent: response.reasoningContent }
          : {}),
      });

      for (const toolCall of response.toolCalls) {
        if (deps.toolExecutor) {
          const tcStart = Date.now();
          const preToolOutcome = await runPreToolUseHook(hookOpts, {
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
          });
          if (preToolOutcome.skipped) {
            messages.push({
              role: "tool",
              content: JSON.stringify({
                error: `pre-tool-use hook aborted: ${preToolOutcome.reason}`,
              }),
              toolCallId: toolCall.id,
            });
            continue;
          }
          const effectiveTc = preToolOutcome.toolCall;

          const rawResult = await deps.toolExecutor.execute(
            {
              toolCallId: effectiveTc.id,
              name: effectiveTc.name,
              arguments: effectiveTc.arguments,
            },
            {
              sessionId: suspension.sessionId,
              turnId: suspension.turnId,
              pluginId: manifest.pluginId,
              runtimeId: manifest.name,
              pendingProposals,
              emitter: deps.emitter,
            },
          );

          const { result, terminate: terminateAfterTool } =
            await runPostToolUseHook(
              hookOpts,
              {
                id: effectiveTc.id,
                name: effectiveTc.name,
                arguments: effectiveTc.arguments,
              },
              rawResult,
            );

          if (!result.success) {
            failedToolCalls.push({
              toolName: effectiveTc.name,
              message: extractToolFailureMessage(result.result),
            });
          }

          if (result.pendingProposals && result.pendingProposals.length > 0) {
            pendingProposals.push(...result.pendingProposals);
          }

          if (isSuspendSentinel(result.parsedResult)) {
            messages.push({
              role: "tool",
              content: JSON.stringify({
                error: "Nested suspend is not supported",
              }),
              toolCallId: effectiveTc.id,
            });
            continue;
          }

          executedToolCalls.push({
            name: effectiveTc.name,
            arguments: effectiveTc.arguments,
            result: result.parsedResult,
            success: result.success,
          });

          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = JSON.parse(effectiveTc.arguments) as Record<
              string,
              unknown
            >;
          } catch {
            // keep empty
          }
          collectedToolCalls.push({
            toolCallId: effectiveTc.id,
            toolName: effectiveTc.name,
            pluginId: manifest.pluginId,
            runtimeId: manifest.name,
            turnId: suspension.turnId,
            input: parsedInput,
            output: result.parsedResult,
            durationMs: Date.now() - tcStart,
            approvalStatus: result.approvalStatus ?? "auto-allowed",
            timestamp: new Date().toISOString(),
          });

          messages.push({
            role: "tool",
            content: result.result,
            toolCallId: effectiveTc.id,
          });

          if (terminateAfterTool) {
            terminatedByHook = true;
            break;
          }
        } else {
          messages.push({
            role: "tool",
            content: JSON.stringify({ result: "Tool execution not available" }),
            toolCallId: toolCall.id,
          });
        }
      }

      if (terminatedByHook) {
        stoppedWithResponse = true;
        break;
      }
      continue;
    }

    finalContent = response.content;
    stoppedWithResponse = true;
    break;
  }

  if (!stoppedWithResponse && !finalContent) {
    return finalizeWithPostRuntime({
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      runId,
      turnId: suspension.turnId,
      status: "failed",
      output: null,
      toolCalls: collectedToolCalls,
      durationMs: Date.now() - startTime,
      error: formatToolLoopFailure({
        runtimeId: manifest.name,
        reason: Date.now() >= deadline ? "timeout" : "max_steps",
        maxSteps,
        failedToolCalls,
      }),
      timestamp: new Date().toISOString(),
    });
  }

  let output: Record<string, unknown>;
  const presentableToolOutput = findPresentableToolOutput(executedToolCalls);
  const structuredToolOutput = findLastStructuredToolOutput(executedToolCalls);
  if (finalContent) {
    const parsed = parseFinalOutputEnvelope(finalContent);
    output = shouldSuppressToolLoopNarrative({
      outputKind: manifest.outputKind,
      executedToolCalls,
      parsedAsJson: parsed.parsedAsJson,
    })
      ? (structuredToolOutput ??
        presentableToolOutput ?? { narrativeOutput: "" })
      : parsed.output;
  } else if (failedToolCalls.length > 0) {
    return finalizeWithPostRuntime({
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      runId,
      turnId: suspension.turnId,
      status: "failed",
      output: null,
      toolCalls: collectedToolCalls,
      durationMs: Date.now() - startTime,
      error: formatToolLoopFailure({
        runtimeId: manifest.name,
        reason: "tool_failed_without_output",
        failedToolCalls,
      }),
      timestamp: new Date().toISOString(),
    });
  } else {
    output = presentableToolOutput ?? { narrativeOutput: "" };
  }

  const interactions: Array<Record<string, unknown>> = [];
  for (const tc of executedToolCalls) {
    if (!tc.success || !isRecord(tc.result)) continue;
    if (isRecord(tc.result.interaction)) {
      interactions.push(tc.result.interaction);
    }
  }

  if (interactions.length > 0) {
    output.interactions = interactions;
    if (finalContent && !output.narrativeOutput) {
      output.narrativeOutput = finalContent;
    }
  }

  if (
    manifest.outputKind === "story" &&
    typeof output.narrativeOutput === "string"
  ) {
    output.narrativeOutput = sanitizeStoryNarrativeText(output.narrativeOutput);
  }

  if (pendingProposals.length > 0) {
    output = withPendingProposals(output, pendingProposals) as Record<
      string,
      unknown
    >;
  }

  if (deps.store) {
    await deps.store.markSuspensionResolved(suspension.id);
  }

  emitSubEvent(deps.eventBus, "game", "turn.resumed", suspension.sessionId, {
    sessionId: suspension.sessionId,
    turnId: suspension.turnId,
    suspensionId: suspension.id,
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
  });

  return finalizeWithPostRuntime({
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    runId,
    turnId: suspension.turnId,
    status: "success",
    output,
    toolCalls: collectedToolCalls,
    durationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  });
}
