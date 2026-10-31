/**
 * Suspend handling for the agent tool-call loop.
 *
 * When a tool returns the suspend sentinel, the loop must capture its full
 * mid-turn state (messages, partial content, collected tool calls, buffered
 * proposals, and the loop state the transcript cannot carry) into an
 * execution-local {@link SuspensionRecord} artifact, emit `runtime.completed`,
 * and exit with a `status: "suspended"` RuntimeResult. PostRuntime does not
 * run: it runs once, when the logical runtime really ends. Extracted from
 * `turn-agent-tool-loop.ts` so the main loop stays focused on iteration.
 */

import type {
  Proposal,
  ExecutionContext,
  RuntimeManifest,
  RuntimeResult,
  ToolCallRecord,
  TurnInput,
  InputSlot,
} from "@covel/shared";
import type { SuspendedLoopState, SuspensionRecord } from "@covel/store";
import type { EmittedEvent, SuspendSentinel } from "@covel/tools";
import type { LLMMessage } from "@covel/shared";
import type { HookPipeline } from "../hooks/pipeline.js";
import { finalizeSuspension } from "../turn-executor/runtime-scaffold.js";
import type { AgentLoopDeps } from "../turn-executor/turn-executor-types.js";
import { suspensionBasis } from "./suspension-settlement.js";

export interface HandleSuspensionOptions {
  readonly sentinel: SuspendSentinel;
  readonly manifest: RuntimeManifest;
  readonly input: TurnInput;
  readonly deps: AgentLoopDeps;
  readonly hookPipeline: HookPipeline | undefined;
  readonly messages: readonly LLMMessage[];
  readonly finalContent: string | null;
  readonly collectedToolCalls: readonly ToolCallRecord[];
  readonly completionCalls?: SuspensionRecord["pendingContinuation"]["completionCalls"];
  readonly pendingProposals: readonly Proposal[];
  readonly emittedEvents: readonly EmittedEvent[];
  readonly executionContext: ExecutionContext;
  /** Scope the runtime's `ctx.progress` tasks report under, when not its own execution (a nested call). */
  readonly progressScopeId?: string;
  /** Numeric clock of this execution, restored into the tool context on resume. */
  readonly logicalTurn?: number;
  readonly turnNumber?: number;
  /** User messages of the current turn in `messages`; the resume budget keeps them. */
  readonly currentTurnUserMessages?: number;
  readonly inputSlots?: Readonly<Record<string, InputSlot>>;
  readonly suspendToolCallId: string;
  readonly startTime: number;
  readonly runId: string;
  readonly outputContractSchema?: Readonly<Record<string, unknown>>;
  /** Loop state beyond the transcript; empty parts are not stored. */
  readonly loop?: LoopStateAtSuspension;
  /** The prompt segments `PreLLMCall` hooks received before the suspension. */
  readonly promptSegments?: SuspensionRecord["pendingContinuation"]["promptSegments"];
}

/** What the loop holds at the suspension, before empty parts are dropped. */
export interface LoopStateAtSuspension {
  readonly corrections: Readonly<
    Record<keyof NonNullable<SuspendedLoopState["corrections"]>, number>
  >;
  readonly activatedTools: readonly string[];
  readonly steeredProse: readonly string[];
  readonly completingToolOutput: Readonly<Record<string, unknown>> | null;
}

/** The stored loop state: every empty part left out, undefined when all are. */
export function suspendedLoopState(
  loop: LoopStateAtSuspension,
): SuspendedLoopState | undefined {
  const corrections = Object.fromEntries(
    Object.entries(loop.corrections).filter(([, count]) => count > 0),
  ) as SuspendedLoopState["corrections"];
  const state: SuspendedLoopState = {
    ...(corrections && Object.keys(corrections).length > 0
      ? { corrections }
      : {}),
    ...(loop.activatedTools.length > 0
      ? { activatedTools: [...loop.activatedTools] }
      : {}),
    ...(loop.steeredProse.length > 0
      ? { steeredProse: [...loop.steeredProse] }
      : {}),
    ...(loop.completingToolOutput
      ? { completingToolOutput: structuredClone(loop.completingToolOutput) }
      : {}),
  };
  return Object.keys(state).length > 0 ? state : undefined;
}

/**
 * Return the terminal `suspended` RuntimeResult with an execution-local
 * continuation artifact. Persistence belongs to `finalizeExecution`.
 */
export async function handleSuspension(
  opts: HandleSuspensionOptions,
): Promise<RuntimeResult> {
  const {
    sentinel,
    manifest,
    input,
    deps,
    hookPipeline,
    messages,
    finalContent,
    collectedToolCalls,
    pendingProposals,
    emittedEvents,
    executionContext,
    suspendToolCallId,
    startTime,
    runId,
  } = opts;

  const suspensionId = crypto.randomUUID();
  const loop = opts.loop ? suspendedLoopState(opts.loop) : undefined;

  // Capture the provider-valid transcript (including a placeholder tool result
  // for the suspender and cancellation results for later calls in its batch)
  // together with buffered writes so resume can continue atomically.
  const pendingContinuation: SuspensionRecord["pendingContinuation"] = {
    messages: [...messages],
    partialContent: finalContent ?? undefined,
    toolCallsSoFar: [...collectedToolCalls],
    ...(opts.completionCalls ? { completionCalls: opts.completionCalls } : {}),
    pendingProposals: [...pendingProposals],
    ...(opts.inputSlots ? { inputSlots: opts.inputSlots } : {}),
    ...(emittedEvents.length > 0 ? { emittedEvents: [...emittedEvents] } : {}),
    executionContext,
    ...(input.actions ? { actions: structuredClone(input.actions) } : {}),
    // A nested call reports progress under the root execution's scope.
    ...(opts.progressScopeId !== undefined &&
    opts.progressScopeId !== executionContext.executionId
      ? { progressScopeId: opts.progressScopeId }
      : {}),
    // `executeTurn` sets the player turns once it knows the whole execution.
    takenUnder: suspensionBasis(manifest, 0),
    ...(input.locale !== undefined ? { locale: input.locale } : {}),
    ...(opts.logicalTurn !== undefined
      ? { logicalTurn: opts.logicalTurn }
      : {}),
    ...(opts.turnNumber !== undefined ? { turnNumber: opts.turnNumber } : {}),
    ...(opts.currentTurnUserMessages !== undefined
      ? { currentTurnUserMessages: opts.currentTurnUserMessages }
      : {}),
    // Store the suspend tool's call ID so resume can append a proper tool result
    suspendToolCallId,
    ...(loop ? { loop } : {}),
    ...(opts.promptSegments?.length
      ? {
          promptSegments: opts.promptSegments.map(({ pluginId, id }) => ({
            pluginId,
            id,
          })),
        }
      : {}),
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

  return finalizeSuspension(
    { ...deps, hookPipeline },
    { manifest, input, runId, startTime },
    {
      record: suspension,
      toolCalls: [...collectedToolCalls],
      stop: { reason: "suspended" },
    },
    { outputContractSchema: opts.outputContractSchema },
  );
}
