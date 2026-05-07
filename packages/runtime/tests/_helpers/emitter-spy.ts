/**
 * Shared in-memory TurnEmitter spy for tests that exercise trace fan-out.
 *
 * Every `emit()` pushes `{ type, payload }` onto `.events` so assertions
 * can find and match specific trace events without reaching into a store
 * or eventBus implementation.
 */

import type { TurnEmitter } from "../../src/turn-emitter.js";

export interface EmitterSpy extends TurnEmitter {
  readonly events: Array<{ type: string; payload: Record<string, unknown> }>;
}

export function makeEmitterSpy(
  sessionId = "sess",
  turnId = "turn",
): EmitterSpy {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    sessionId,
    turnId,
    async emit(type: string, payload: Record<string, unknown>): Promise<void> {
      events.push({ type, payload });
    },
    events,
  };
}
