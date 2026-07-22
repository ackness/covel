import type {
  ExecutionContext,
  ExecutionOrigin,
  TurnInput,
} from "@covel/shared";

/**
 * Normalize the transitional `TurnInput.origin` into the canonical
 * `ExecutionOrigin`. The only remapping is the legacy `follower` label →
 * `background`; every other value passes through, and an absent origin is a
 * player turn.
 */
function normalizeOrigin(origin: TurnInput["origin"]): ExecutionOrigin {
  return origin === "follower" ? "background" : (origin ?? "player");
}

/** Legacy `turn_results.origin` domain (matches `TurnResultRecord.origin`). */
type LegacyOrigin = NonNullable<TurnInput["origin"]>;

/**
 * Compat projection back to the legacy `turn_results.origin` label so the
 * persisted column and every API shape stay byte-identical during the
 * scheduling redesign. Only `background` differs (→ `follower`); the other
 * current origins are identity. Removed in Step 6 once readers consume
 * `ExecutionOrigin`.
 */
export function toLegacyOrigin(origin: ExecutionOrigin): LegacyOrigin {
  switch (origin) {
    case "background":
      return "follower";
    case "player":
    case "manual":
    case "recursive":
      return origin;
    case "continuation":
    case "resume":
      // Unreachable in this step: no entry produces these (the resume path is
      // untouched here). Projected to a non-counting label until later steps
      // give them their own persisted value.
      return "manual";
  }
}

/**
 * Create the immutable `ExecutionContext` for one scheduling pipeline run.
 *
 * Single creation point: every entry (player action, manual RPC, deferred
 * follower, nested recursiveCall) flows through `executeTurn`, so the origin is
 * normalized and the counting responsibility fixed exactly once, here. Nested
 * recursiveCall executions therefore get their own context (fresh
 * `executionId`, `origin: "recursive"`, `countPolicy: "none"`) rather than
 * inheriting the parent's.
 *
 * `countPolicy` is recorded but NOT yet consumed this step — the finalizer
 * still gates turn accounting on the projected legacy origin. It is
 * `complete-player-turn` only for a genuine main-loop player turn (player
 * origin, Pre-Game not pending); a setup request or any non-player execution is
 * `none`. `preGamePending` is the transition input the actions route feeds from
 * its pre-turn snapshot.
 */
export function createExecutionContext(input: TurnInput): ExecutionContext {
  const origin = normalizeOrigin(input.origin);
  const countPolicy =
    origin === "player" && input.preGamePending !== true
      ? "complete-player-turn"
      : "none";
  return {
    executionId: crypto.randomUUID(),
    origin,
    countPolicy,
  };
}
