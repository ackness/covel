import type { SessionExecutionStatus } from "@covel/shared";
import type * as api from "@/services/api.js";
import {
  deriveRuntimesFromTurn,
  getDisplayType,
  type RuntimeInfo,
} from "./-debug-helpers.js";

export function isTurnInterrupted(
  turn: api.TurnTrace,
  execution?: SessionExecutionStatus,
): boolean {
  if (execution?.state !== "interrupted" || execution.turnId !== turn.turnId) {
    return false;
  }
  // A newer terminal trace takes precedence over a stale status response.
  return !turn.events.some((event) =>
    ["turn.completed", "flow.completed", "turn.failed", "flow.failed"].includes(
      getDisplayType(event),
    ),
  );
}

export function getTurnRuntimes(
  turn: api.TurnTrace,
  execution?: SessionExecutionStatus,
): RuntimeInfo[] {
  const runtimes = deriveRuntimesFromTurn(turn.events);
  if (!isTurnInterrupted(turn, execution)) return runtimes;
  return runtimes.map((runtime) =>
    runtime.status === "running"
      ? { ...runtime, status: "interrupted" }
      : runtime,
  );
}
