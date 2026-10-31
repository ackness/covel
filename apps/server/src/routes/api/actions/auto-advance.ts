import { z } from "zod";
import {
  resolveAutoAdvanceLimit,
  turnActionSchema,
  type ExecutionAdvancePayload,
  type ExecutionAdvanceStopReason,
  type TurnAction,
} from "@covel/shared";
import type { FinalizeExecutionOutcome } from "@covel/runtime";
import type { DataStore, SessionRecord } from "@covel/store";

/** Only post-hook, durably committed top-level stories can request a round. */
export async function committedAdvanceDecision(
  store: DataStore,
  sessionId: string,
  outcome: FinalizeExecutionOutcome,
): Promise<ExecutionAdvanceStopReason | undefined> {
  if (outcome.status !== "committed") return "execution-failed";
  const ids = outcome.topLevelNarrativeMessageIds ?? [];
  if (ids.length === 0) return "no-eligible-story";
  if (ids.length !== 1) return "ambiguous-story";
  const message = await store.getMessage(sessionId, ids[0]!);
  const metadata = z
    .object({ yield: z.string().optional() })
    .safeParse(message?.metadata);
  return metadata.success && metadata.data.yield === "continue"
    ? undefined
    : "yielded-to-player";
}

const provenanceSchema = z.object({
  rootId: z.string().min(1),
  logicalTurn: z.number().int().positive(),
  kind: z.enum(["root", "opening", "advance"]),
  actions: z.array(turnActionSchema).optional(),
});
export type AdvanceProvenance = z.infer<typeof provenanceSchema>;

/** Retry reads provenance, never unused budget or a historical continue flag. */
export async function readAdvanceProvenance(
  store: DataStore,
  sessionId: string,
  turnId?: string,
): Promise<AdvanceProvenance | undefined> {
  if (!turnId) return;
  const [started] = await store.queryTraceEvents(sessionId, {
    turnId,
    types: ["turn.started"],
    limit: 1,
  });
  const parsed = provenanceSchema.safeParse(
    (started?.payload as Record<string, unknown> | undefined)?.advancement,
  );
  return parsed.success ? parsed.data : undefined;
}

/** Request-owned context. Nothing here is inherited by a snapshot or fork. */
export function createAdvanceRoot(requestId: string) {
  let rootId: string = crypto.randomUUID();
  let logicalTurn: number | undefined;
  let limit = 0;
  let round = 0;
  let preferredSeat: string | undefined;
  return {
    get rootId() {
      return rootId;
    },
    get logicalTurn() {
      return logicalTurn;
    },
    get limit() {
      return limit;
    },
    get round() {
      return round;
    },
    freeze(session: SessionRecord, recovered?: AdvanceProvenance) {
      if (logicalTurn !== undefined) return;
      rootId = recovered?.rootId ?? rootId;
      logicalTurn = recovered?.logicalTurn ?? session.completedPlayerTurns + 1;
      limit = resolveAutoAdvanceLimit(session.metadata?.autoAdvanceLimit);
    },
    rememberSeat(actions?: readonly TurnAction[]) {
      preferredSeat ??= actions?.[0]?.seatId;
    },
    systemAction(session: SessionRecord): TurnAction | undefined {
      const humans = session.seats.filter(
        (seat) => seat.controller === "human",
      );
      const seat =
        humans.find((seat) => seat.id === preferredSeat) ?? humans[0];
      return seat
        ? turnActionSchema.parse({
            kind: "advance",
            source: "system",
            seatId: seat.id,
          })
        : undefined;
    },
    reserve() {
      round += 1;
    },
    progress(
      phase: "waiting" | "running",
      turnId?: string,
    ): ExecutionAdvancePayload {
      return {
        requestId,
        rootId,
        phase,
        round: phase === "waiting" ? round + 1 : round,
        limit,
        ...(turnId ? { turnId } : {}),
      };
    },
    stopped(
      reason: ExecutionAdvanceStopReason,
      turnId?: string,
    ): ExecutionAdvancePayload {
      return {
        requestId,
        rootId,
        phase: "stopped",
        round,
        limit,
        reason,
        ...(turnId ? { turnId } : {}),
      };
    },
    provenance(
      kind: AdvanceProvenance["kind"],
      actions?: readonly TurnAction[],
    ): AdvanceProvenance {
      if (logicalTurn === undefined)
        throw new Error("Input clock is not frozen");
      return {
        rootId,
        logicalTurn,
        kind,
        ...(actions ? { actions: [...actions] } : {}),
      };
    },
  };
}

/** An unanswered interaction or suspension hands control back to the player. */
export async function hasPendingAdvanceInput(
  store: DataStore,
  sessionId: string,
): Promise<boolean> {
  const [suspensions, messages, answers] = await Promise.all([
    store.listSuspensions(sessionId),
    store.listTurnMessages(sessionId),
    store.listPlayerInputs(sessionId),
  ]);
  if (suspensions.some((record) => record.resolvedAt === undefined))
    return true;
  const answered = new Set(
    answers.map((answer) => JSON.stringify([answer.turnId, answer.formId])),
  );
  return messages.some(
    (message) =>
      Array.isArray(message.pendingInput) &&
      message.pendingInput.some((input: unknown) => {
        const interaction = z
          .object({
            interactionId: z.string(),
            type: z.enum(["form", "choice", "confirmation"]),
          })
          .safeParse(input);
        return (
          interaction.success &&
          !answered.has(
            JSON.stringify([message.turnId, interaction.data.interactionId]),
          )
        );
      }),
  );
}

export interface AdvanceRoundOutcome {
  readonly committed: boolean;
  readonly stopReason?: ExecutionAdvanceStopReason;
  readonly fanOutFailed: boolean;
}

/** Each callback acquires and releases its own settled lock. */
export async function runAutoAdvance<T extends AdvanceRoundOutcome>(args: {
  readonly root: ReturnType<typeof createAdvanceRoot>;
  readonly control: import("../turn-control.js").ActionRequestControl;
  readonly first: T;
  readonly enabled: boolean;
  readonly publish: (progress: ExecutionAdvancePayload) => Promise<void>;
  readonly run: () => Promise<{
    outcome?: T;
    stopped?: ExecutionAdvanceStopReason;
  }>;
}): Promise<{ final: T; resync: boolean; reason: ExecutionAdvanceStopReason }> {
  let final = args.first;
  let resync = final.fanOutFailed;
  let reason: ExecutionAdvanceStopReason =
    final.stopReason ?? "yielded-to-player";
  while (args.enabled && !final.stopReason && final.committed) {
    if (!args.control.canAdvance) {
      reason = args.control.stopReason ?? "player-stop";
      break;
    }
    if (args.root.round >= args.root.limit) {
      reason = args.root.limit === 0 ? "disabled" : "limit";
      break;
    }
    await args.publish(args.root.progress("waiting"));
    if (!args.control.canAdvance) {
      reason = args.control.stopReason ?? "player-stop";
      break;
    }
    const next = await args.run();
    if (!next.outcome) {
      reason = next.stopped ?? args.control.stopReason ?? "session-unavailable";
      break;
    }
    final = next.outcome;
    resync ||= next.outcome.fanOutFailed;
    reason = final.stopReason ?? "yielded-to-player";
  }
  if (!args.control.canAdvance)
    reason = args.control.stopReason ?? "player-stop";
  await args.publish(args.root.stopped(reason));
  return { final, resync, reason };
}
