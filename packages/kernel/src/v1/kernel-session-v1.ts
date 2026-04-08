import { randomUUID } from "node:crypto";
import type { LoadedRuntime, PluginManager } from "@covel/plugin-manager";
import type { ApprovalService, PublishedRecord } from "@covel/services";
import { wrapAsPublishedRecord, successResult, failedResult, skippedLimitResult } from "@covel/runtime-context";
import type {
  V1ApprovalCallbackResult,
  V1TriggerInput,
  V1RuntimeSummary,
  V1TurnResult,
  V1RuntimeResult,
  V1KernelSession,
  V1SessionState,
  V1WorkflowState,
} from "./types.js";
import { routeTriggerV1 } from "./trigger-router-v1.js";
import { buildV1ExecutionPlan } from "./scheduler-v1.js";

const PRE_GAME_BOUNDARY = 100;

export interface V1KernelConfig {
  pluginManager: PluginManager;
  /** Execute a single runtime and return result. Injected by kernel for LLM/handler dispatch. */
  executeRuntime?: (runtime: LoadedRuntime, input: V1TriggerInput, sessionState: V1SessionState) => Promise<V1RuntimeResult>;
  approvalService?: ApprovalService;
}

/**
 * Create a V1 KernelSession.
 */
export function createV1KernelSession(
  config: V1KernelConfig,
  sessionId: string,
): V1KernelSession {
  const state: V1SessionState = {
    sessionId,
    turnNumber: 0,
    isPreGame: true,
    preGameCompleted: new Set(),
    runCounts: new Map(),
    eventQueue: [],
    records: [],
  };

  const workflows = new Map<string, V1WorkflowState>();

  // Default runtime executor (stub — real one injected by kernel with LLM)
  const execRuntime = config.executeRuntime ?? defaultExecuteRuntime;

  function resolveActionLabel(
    text: unknown,
    defaultLocale: string,
  ): string | undefined {
    if (!text) return undefined;
    if (typeof text === "string") return text;
    if (typeof text === "object" && text !== null) {
      const record = text as Record<string, string>;
      return record[defaultLocale] ?? Object.values(record)[0];
    }
    return undefined;
  }

  async function executeTurn(input: V1TriggerInput): Promise<V1TurnResult> {
    const turnId = input.turnId || `turn-${randomUUID()}`;
    const traceId = `trace-${randomUUID()}`;
    const turnRecords: PublishedRecord[] = [];
    const pendingEvents: string[] = [];

    // Reset per-turn run counts
    for (const [key, counts] of state.runCounts) {
      state.runCounts.set(key, { ...counts, turn: 0 });
    }

    // If this is an event-triggered turn, consume the event queue
    let effectiveInput = input;
    if (input.type === "turn" && state.eventQueue.length > 0) {
      // Process pending domain events from previous turn
      const events = [...state.eventQueue];
      state.eventQueue = [];
      // Fire event-triggered runtimes as additional candidates
      for (const eventType of events) {
        const eventInput: V1TriggerInput = {
          ...input,
          type: "event",
          eventType,
          turnId,
        };
        const eventCandidates = routeTriggerV1(
          eventInput,
          getAllRuntimes(),
          state,
        );
        // Execute event-triggered runtimes (they join the normal priority pipeline)
        // For simplicity in V1, we run them inline as a separate pass
        const eventPlan = buildV1ExecutionPlan(eventCandidates);
        for (const group of eventPlan.groups) {
          const groupResults = await executeGroup(group.runtimes, eventInput, turnId, traceId);
          turnRecords.push(...groupResults.map((r) => r.record));
        }
      }
    }

    // Route trigger to candidates
    const candidates = routeTriggerV1(effectiveInput, getAllRuntimes(), state);
    const plan = buildV1ExecutionPlan(candidates);

    // Execute groups sequentially
    for (const group of plan.groups) {
      const groupResults = await executeGroup(group.runtimes, effectiveInput, turnId, traceId);
      turnRecords.push(...groupResults.map((r) => r.record));
    }

    // Advance state
    state.turnNumber++;
    if (state.isPreGame && state.turnNumber > 0) {
      // Check if we've completed pre-game (all pre-game runtimes done or boundary crossed)
      const hasPreGameRemaining = getAllRuntimes().some(
        (r) => r.manifest.priority < PRE_GAME_BOUNDARY &&
          r.manifest.trigger.type === "pre-game-once" &&
          !state.preGameCompleted.has(`${r.pluginId}:${r.manifest.id}`),
      );
      if (!hasPreGameRemaining) {
        state.isPreGame = false;
      }
    }

    state.records.push(...turnRecords);
    // pendingEvents would be populated if runtimes emitted domain events
    // (handled externally via EventBus)

    return { turnId, traceId, records: turnRecords, pendingEvents };
  }

  async function executeGroup(
    candidates: Array<{ runtime: LoadedRuntime; triggerInput: V1TriggerInput }>,
    input: V1TriggerInput,
    turnId: string,
    traceId: string,
  ): Promise<V1RuntimeResult[]> {
    const results = await Promise.allSettled(
      candidates.map(async (c) => {
        const qid = `${c.runtime.pluginId}:${c.runtime.manifest.id}`;

        // Increment run counts
        const counts = state.runCounts.get(qid) ?? { session: 0, turn: 0 };
        counts.session++;
        counts.turn++;
        state.runCounts.set(qid, counts);

        // Mark pre-game-once as completed
        if (c.runtime.manifest.trigger.type === "pre-game-once") {
          state.preGameCompleted.add(qid);
        }

        try {
          return await execRuntime(c.runtime, { ...input, turnId }, state);
        } catch (err) {
          const failResult = failedResult(
            err instanceof Error ? err.message : String(err),
          );
          return {
            pluginId: c.runtime.pluginId,
            runtimeId: c.runtime.manifest.id,
            status: failResult.status,
            payload: failResult.payload,
            failureReason: failResult.failureReason,
            record: wrapAsPublishedRecord(failResult, {
              pluginId: c.runtime.pluginId,
              runtimeId: c.runtime.manifest.id,
              sessionId: state.sessionId,
              turnId,
              runId: `run-${randomUUID()}`,
              traceId,
              locale: "zh-CN",
            }),
          } satisfies V1RuntimeResult;
        }
      }),
    );

    return results
      .filter((r): r is PromiseFulfilledResult<V1RuntimeResult> => r.status === "fulfilled")
      .map((r) => r.value);
  }

  async function executeSingleRuntime(
    pluginId: string,
    runtimeId: string,
    payload?: unknown,
  ): Promise<V1RuntimeResult> {
    const runtime = config.pluginManager.registries.runtimes.get(pluginId, runtimeId);
    if (!runtime) throw new Error(`Runtime "${pluginId}:${runtimeId}" not found.`);

    const turnId = `manual-turn-${randomUUID()}`;
    const traceId = `trace-${randomUUID()}`;
    const input: V1TriggerInput = {
      type: "manual",
      sessionId,
      turnId,
      payload,
    };

    const result = await execRuntime(runtime, input, state);
    state.records.push(result.record);
    return result;
  }

  async function executeAction(
    pluginId: string,
    actionId: string,
    payload?: unknown,
  ): Promise<V1WorkflowState> {
    const plugin = config.pluginManager.registries.plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin "${pluginId}" not found.`);

    const action = plugin.manifest.actions?.find((a: { id: string }) => a.id === actionId);
    if (!action) throw new Error(`Action "${actionId}" not found in plugin "${pluginId}".`);
    if (!action.workflow) throw new Error(`Action "${actionId}" has no workflow.`);

    const workflowRunId = `wf-${randomUUID()}`;
    const workflowState: V1WorkflowState = {
      workflowRunId,
      pluginId,
      actionId,
      status: "queued",
      currentStep: null,
      steps: action.workflow.steps.map((s: string) => ({ runtimeId: s, status: "queued" as const })),
    };
    workflows.set(workflowRunId, workflowState);

    // Execute steps serially
    let previousPayload: unknown = payload;
    workflowState.status = "running";
    workflowState.progressLabel = resolveActionLabel(
      action.progressLabels?.queued,
      plugin.manifest.defaultLocale,
    );

    for (let i = 0; i < action.workflow.steps.length; i++) {
      const stepRuntimeId = action.workflow.steps[i];
      const stepState = workflowState.steps[i];
      workflowState.currentStep = stepRuntimeId;
      stepState.status = "running";
      workflowState.progressLabel = resolveActionLabel(
        action.progressLabels?.[`${stepRuntimeId}.running`],
        plugin.manifest.defaultLocale,
      );

      try {
        const stepInput = i === 0
          ? previousPayload
          : {
              previousStep: {
                runtimeId: action.workflow.steps[i - 1],
                status: "success",
                payload: previousPayload,
              },
            };

        const result = await executeSingleRuntime(pluginId, stepRuntimeId, stepInput);

        if (result.status === "success") {
          stepState.status = "completed";
          previousPayload = result.payload;
        } else {
          // Step failed → workflow fails, no further steps
          stepState.status = "failed";
          workflowState.status = "failed";
          workflowState.failedAtStep = stepRuntimeId;
          workflowState.progressLabel = resolveActionLabel(
            action.progressLabels?.failed,
            plugin.manifest.defaultLocale,
          );
          break;
        }
      } catch (err) {
        stepState.status = "failed";
        workflowState.status = "failed";
        workflowState.failedAtStep = stepRuntimeId;
        workflowState.progressLabel = resolveActionLabel(
          action.progressLabels?.failed,
          plugin.manifest.defaultLocale,
        );
        break;
      }
    }

    if (workflowState.status === "running") {
      workflowState.status = "completed";
      workflowState.currentStep = null;
      workflowState.progressLabel = resolveActionLabel(
        action.progressLabels?.completed,
        plugin.manifest.defaultLocale,
      );
    }

    return workflowState;
  }

  function getWorkflow(workflowRunId: string): V1WorkflowState | undefined {
    return workflows.get(workflowRunId);
  }

  function listRuntimes(): V1RuntimeSummary[] {
    return getAllRuntimes().map((runtime) => ({
      pluginId: runtime.pluginId,
      runtimeId: runtime.manifest.id,
      priority: runtime.manifest.priority,
      trigger: runtime.manifest.trigger,
      settings: runtime.manifest.settings,
      systemTools: runtime.manifest.systemTools,
      toolImports: runtime.manifest.toolImports,
    }));
  }

  function getLastRecord(pluginId: string, runtimeId: string): PublishedRecord | undefined {
    return [...state.records]
      .reverse()
      .find((record) => record.pluginId === pluginId && record.runtimeId === runtimeId);
  }

  async function handleApprovalCallback(
    interactionId: string,
    decision: "approved" | "denied",
    response?: unknown,
  ): Promise<V1ApprovalCallbackResult> {
    const match = interactionId.match(/^approval:([^:]+):([^:]+):(.+)$/);
    if (match && decision === "approved" && config.approvalService) {
      const [, approvedSessionId, pluginId, toolId] = match;
      if (approvedSessionId === sessionId) {
        await config.approvalService.grant({
          sessionId,
          pluginId,
          toolId,
        });
      }
    }

    return {
      interactionId,
      decision,
      response,
      status: "processed",
    };
  }

  function getAllRuntimes(): LoadedRuntime[] {
    return config.pluginManager.registries.runtimes.listAll();
  }

  return {
    executeTurn,
    executeRuntime: executeSingleRuntime,
    executeAction,
    getWorkflow,
    listRuntimes,
    getLastRecord,
    handleApprovalCallback,
    state,
  };
}

async function defaultExecuteRuntime(
  runtime: LoadedRuntime,
  input: V1TriggerInput,
  sessionState: V1SessionState,
): Promise<V1RuntimeResult> {
  const result = successResult({ stub: true, runtimeId: runtime.manifest.id });
  return {
    pluginId: runtime.pluginId,
    runtimeId: runtime.manifest.id,
    status: result.status,
    payload: result.payload,
    record: wrapAsPublishedRecord(result, {
      pluginId: runtime.pluginId,
      runtimeId: runtime.manifest.id,
      sessionId: sessionState.sessionId,
      turnId: input.turnId,
      runId: `run-${randomUUID()}`,
      traceId: `trace-${randomUUID()}`,
      locale: "zh-CN",
    }),
  };
}
