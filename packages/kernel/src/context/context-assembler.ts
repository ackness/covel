import type {
  RuntimeContextView,
  RuntimeTriggerEvent,
} from "@covel/shared";
import type { RegisteredRuntime } from "@covel/plugin-runtime";
import type { TurnState } from "../types.js";

export interface ContextAssemblyInput {
  runId: string;
  branchId: string;
  turnId: string;
  locale: string;
  runtime: RegisteredRuntime;
  triggerEvent: RuntimeTriggerEvent;
  /** Current accumulated turn state. */
  turnState: TurnState;
  /** Global game state snapshot at turn start. */
  worldState?: unknown;
  /** Characters data. */
  characters?: unknown[];
  /** Chat history. */
  chat?: unknown;
  /** Runtime settings. */
  runtimeSettings?: {
    flat?: Record<string, unknown>;
    byPlugin?: Record<string, Record<string, unknown>>;
  };
  /** Archive data. */
  archive?: { activeVersion?: number; latestVersion?: number; summary?: string };
}

/**
 * Assemble a RuntimeContextView for a specific runtime execution.
 */
export function assembleContext(input: ContextAssemblyInput): RuntimeContextView {
  const { runtime, turnState } = input;
  const spec = runtime.spec;

  return {
    run: {
      runId: input.runId,
      branchId: input.branchId,
      turnId: input.turnId,
    },
    locale: input.locale,
    world: input.worldState,
    chat: input.chat,
    characters: input.characters,
    state: turnState.state,
    record: Array.from(turnState.records.values()),
    events: [input.triggerEvent],
    runtimeSettings: input.runtimeSettings,
    narrative: turnState.narrativeSegments.length > 0
      ? { content: turnState.narrativeSegments.join("") }
      : undefined,
    archive: input.archive,
    runtime: {
      runtimeId: spec.id,
      pluginId: runtime.pluginId,
      kind: spec.kind,
      phase: spec.phase,
      allowedTools: spec.tools,
      providerBinding: spec.providerBinding,
      budget: spec.budget,
      isolation: spec.isolation,
    },
  };
}
