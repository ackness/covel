import { snapshotPlayerInput } from "./turn-digest.js";
import type {
  PlayerInputSubmission,
  RuntimeManifest,
  SetupRuntimeState,
  TurnInput,
} from "@covel/shared";
import {
  isSetupRuntime,
  promptHistoryTransformV1,
  turnDigestSchema,
} from "@covel/shared";
import type { TurnMessageRecord } from "@covel/store";
import type { TurnExecutorDeps } from "./turn-executor-types.js";

export interface TurnSessionCharacter {
  readonly id?: string;
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly fields?: Record<string, unknown>;
}

export interface TurnSessionMeta {
  readonly turnNumber: number;
  /** `completedPlayerTurns + 1`, frozen for the execution. */
  readonly logicalTurn: number;
  readonly characters: readonly TurnSessionCharacter[];
  readonly lastPlayerInput: PlayerInputSubmission | null;
  readonly lastFormValues: Record<string, unknown> | undefined;
}

export interface LoadedTurnSessionState {
  readonly messageHistory: readonly TurnMessageRecord[];
  /** Player message waiting for the execution's commit transaction. */
  readonly journalMessages: readonly TurnMessageRecord[];
  readonly runtimeTriggerCounts: ReadonlyMap<string, number>;
  readonly sessionMeta: TurnSessionMeta;
  readonly sessionStatus: "active" | "paused" | "ended";
  readonly turnNumber: number;
  /** Persisted setup/main band. Drives band selection and turn accounting. */
  readonly phase: "setup" | "playing";
  /** Committed main-loop player turns; `logicalTurn = completedPlayerTurns + 1`. */
  readonly completedPlayerTurns: number;
  /** Per-setup-runtime mirror frozen at execution start (setup gate + generation). */
  readonly setupRuntimes: Readonly<Record<string, SetupRuntimeState>>;
}

export async function loadTurnSessionState(args: {
  readonly input: TurnInput;
  readonly deps: TurnExecutorDeps;
  readonly shouldAppendPlayerMessage: boolean;
}): Promise<LoadedTurnSessionState> {
  const { input, deps, shouldAppendPlayerMessage } = args;

  // Bounded per-turn reads: counts come from a store-side aggregate over the
  // FULL log, while the in-memory history is only the uncompacted suffix —
  // the compacted prefix is represented by session summaries at prompt-build
  // time, so a long session never re-loads its whole history every turn.
  let messageHistory: readonly TurnMessageRecord[] = [];
  let turnNumber = 0;
  let runtimeTriggerCounts: ReadonlyMap<string, number> = new Map();
  const journalMessages: TurnMessageRecord[] = [];
  if (deps.store) {
    const [uncompacted, stats] = await Promise.all([
      deps.store.listUncompactedTurnMessages(input.sessionId),
      deps.store.getTurnMessageStats(input.sessionId),
    ]);
    messageHistory = uncompacted;
    turnNumber = stats.playerMessageCount;
    runtimeTriggerCounts = new Map(Object.entries(stats.runtimeMessageCounts));
  }

  if (deps.store && shouldAppendPlayerMessage) {
    const playerMessage: TurnMessageRecord = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      turnId: input.turnId,
      sourceType: "player",
      role: "user",
      content: input.playerMessage,
      order: 0,
      createdAt: new Date().toISOString(),
    };
    journalMessages.push(playerMessage);
  }

  // Trigger counts come only from committed history; this execution's journal
  // is intentionally invisible until finalize succeeds.
  let sessionStatus: "active" | "paused" | "ended" = "active";
  let phase: "setup" | "playing" = "playing";
  let completedPlayerTurns = 0;
  let setupRuntimes: Readonly<Record<string, SetupRuntimeState>> = {};
  let sessionCharacters: TurnSessionCharacter[] = [];
  const sourceDigest = input.detachedStage
    ? turnDigestSchema.parse(input.detachedStage.turnDigest)
    : null;
  if (
    sourceDigest &&
    (sourceDigest.turnId !== input.detachedStage?.sourceTurnId ||
      (sourceDigest.lastPlayerInput &&
        sourceDigest.lastPlayerInput.sessionId !== input.sessionId))
  ) {
    throw new Error(
      "Detached source snapshot does not belong to this execution",
    );
  }
  let lastPlayerInput: PlayerInputSubmission | null = snapshotPlayerInput(
    sourceDigest?.lastPlayerInput ?? null,
  );

  if (deps.store) {
    const session = await deps.store.getSession(input.sessionId);
    if (session) {
      sessionStatus = session.status;
      phase = session.phase;
      completedPlayerTurns = session.completedPlayerTurns;
      setupRuntimes = session.setupRuntimes;
    }

    const charRecords = await deps.store.listCharacters(input.sessionId);
    sessionCharacters = charRecords.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      description: c.description,
      fields: c.fields as Record<string, unknown>,
    }));

    if (!input.detachedStage) {
      lastPlayerInput = await loadLastPlayerInput(deps.store, input.sessionId);
    }
  }

  return {
    messageHistory,
    journalMessages,
    runtimeTriggerCounts,
    sessionMeta: {
      turnNumber,
      logicalTurn: completedPlayerTurns + 1,
      characters: sessionCharacters,
      lastPlayerInput,
      lastFormValues: lastPlayerInput?.values,
    },
    sessionStatus,
    turnNumber,
    phase,
    completedPlayerTurns,
    setupRuntimes,
  };
}

export async function buildProjectedPromptHistory(args: {
  readonly input: TurnInput;
  readonly deps: TurnExecutorDeps;
  readonly messageHistory: readonly TurnMessageRecord[];
}): Promise<readonly TurnMessageRecord[]> {
  const { input, deps, messageHistory } = args;
  const promptHistory = messageHistory.filter(
    (msg) => !(msg.turnId === input.turnId && msg.sourceType === "player"),
  );

  if (!deps.extensionExecution) return promptHistory;
  const result = await deps.extensionExecution.run(promptHistoryTransformV1, {
    messages: promptHistory,
    turnId: input.turnId,
  });
  return result.messages;
}

/**
 * Resolve the setup-band runtimes and whether the session is still in the setup
 * band.
 *
 * The band decision reads the persisted `phase`, the sole scheduling source of
 * truth. Setup completion details live in `setupRuntimes`.
 */
export function getPreGameRuntimeState(
  activeRuntimes: readonly RuntimeManifest[],
  phase: "setup" | "playing",
): {
  readonly preGameRuntimes: readonly RuntimeManifest[];
  readonly isPreGamePending: boolean;
} {
  const preGameRuntimes = activeRuntimes.filter(isSetupRuntime);
  const isPreGamePending = phase === "setup";
  return { preGameRuntimes, isPreGamePending };
}

/** Called once after execution admission, including a new resume invocation. */
export async function loadLastPlayerInput(
  store: import("@covel/store").DataStore | undefined,
  sessionId: string,
): Promise<PlayerInputSubmission | null> {
  const inputs = await store?.listPlayerInputs(sessionId);
  // Store enumeration order is not chronological (SQL has no ORDER BY).
  // Persisted UTC timestamps define recency; IDs break equal-time ties stably.
  const latest = inputs?.reduce<
    import("@covel/store").PlayerInputRecord | null
  >(
    (current, candidate) =>
      !current ||
      candidate.createdAt > current.createdAt ||
      (candidate.createdAt === current.createdAt && candidate.id > current.id)
        ? candidate
        : current,
    null,
  );
  return snapshotPlayerInput(latest ?? null);
}
