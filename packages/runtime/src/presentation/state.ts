import { presentationCompletionSchema } from "@covel/shared";
import type {
  PresentationReason,
  PresentationSnapshot,
  RuntimeResult,
} from "@covel/shared";
import type { createPresentationBudget } from "./budget.js";
import type { TurnEmitter } from "../trace/turn-emitter.js";

export interface PresentationState {
  readonly jobId?: string;
  readonly snapshot: PresentationSnapshot;
  readonly budget: ReturnType<typeof createPresentationBudget>;
  readonly mediaIds: Set<string>;
  reason?: PresentationReason;
  terminal?: boolean;
  committedWrites?: number;
}

const states = new WeakMap<object, PresentationState>();
export function attachPresentationState(
  result: object,
  state: PresentationState,
) {
  states.set(result, state);
}
export function presentationState(result: object) {
  return states.get(result);
}

/** Terminal status is emitted after commit decides whether display writes land. */
export async function completePresentation(
  emitter: TurnEmitter | undefined,
  result: Pick<RuntimeResult, "pluginId" | "runtimeId" | "turnId"> &
    Partial<Pick<RuntimeResult, "runId">>,
  state: PresentationState,
  status: "updated" | "no-op" | "failed",
  reason?: PresentationReason,
): Promise<void> {
  if (state.terminal) return;
  await state.budget.refresh().catch(() => undefined);
  state.terminal = true;
  await emitter?.emit(
    "presentation.completed",
    presentationCompletionSchema.parse({
      pluginId: result.pluginId,
      runtimeId: result.runtimeId,
      runId: result.runId,
      ...(state.jobId ? { jobId: state.jobId } : {}),
      turnId: result.turnId,
      sourceTurnId: state.snapshot.sourceTurnId,
      sourceExecutionId: state.snapshot.sourceExecutionId,
      status,
      ...(status === "updated"
        ? {}
        : { reason: reason ?? state.reason ?? "no-output" }),
      budget: state.budget.usage(),
    }),
  );
}
