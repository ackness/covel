import { act, cleanup, render } from "@testing-library/react";
import type { Dispatch } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  SessionProvider,
  useSession,
  useSessionActions,
  useSessionStructure,
} from "../../session-store.js";
import type { SessionActions, SessionStructureState } from "../context.js";
import type { SessionAction, SessionState } from "../types.js";

const captured = vi.hoisted(() => ({
  dispatch: null as Dispatch<SessionAction> | null,
}));

vi.mock("@/services/data-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/data-service.js")>()),
  getDataService: () => ({}),
  getSessionWorkspace: () => ({}),
}));
vi.mock("../effects.js", () => ({
  useBootEffect: () => {},
  useUiSpecHydrationEffect: () => {},
  usePersistExecutionStepsEffect: () => {},
}));
vi.mock("../execution-recovery.js", () => ({ useExecutionRecovery: () => {} }));
vi.mock("../subscription.js", () => ({
  useSessionSubscription: (args: { dispatch: Dispatch<SessionAction> }) => {
    captured.dispatch = args.dispatch;
  },
}));

afterEach(() => {
  captured.dispatch = null;
  cleanup();
});

it("keeps actual provider actions and structure stable during non-structural and streaming updates", () => {
  let actions!: SessionActions;
  let state!: SessionState;
  let structure!: SessionStructureState;
  let actionRenders = 0;
  let structureRenders = 0;
  let stateRenders = 0;
  function ActionsConsumer() {
    actions = useSessionActions();
    actionRenders += 1;
    return null;
  }
  function StructureConsumer() {
    structure = useSessionStructure();
    structureRenders += 1;
    return null;
  }
  function StateConsumer() {
    state = useSession().state;
    stateRenders += 1;
    return null;
  }
  render(
    <SessionProvider>
      <ActionsConsumer />
      <StructureConsumer />
      <StateConsumer />
    </SessionProvider>,
  );
  const previousActions = actions;
  const previousStructure = structure;
  const draft = {
    id: "draft-1",
    turnId: "turn-1",
    interactionId: "interaction-1",
    type: "suggestion" as const,
    label: "Visit the docks",
    values: { text: "Visit the docks" },
  };
  act(() => actions.upsertInteractionDraft(draft));
  expect(state.pendingInteractionDrafts).toEqual([draft]);
  expect(actions).toBe(previousActions);
  expect(structure).toBe(previousStructure);
  expect(actionRenders).toBe(1);
  expect(structureRenders).toBe(1);

  act(() => {
    captured.dispatch?.({
      type: "OUTPUT_DRAFT",
      draft: {
        turnId: "turn-1",
        runtimeId: "narrator",
        pluginId: "narrator",
        draftId: "draft-1",
        units: [{ text: "Hello " }],
        accepted: false,
        revising: false,
      },
    });
    captured.dispatch?.({
      type: "UPSERT_EXECUTION_STEP",
      step: {
        turnId: "turn-1",
        runtimeId: "narrator",
        pluginId: "narrator",
        status: "running",
      },
    });
  });
  expect(state.outputDrafts).toHaveLength(1);
  expect(state.executionSteps).toHaveLength(1);
  expect(stateRenders).toBeGreaterThan(2);
  expect(structure).toBe(previousStructure);
  expect(structureRenders).toBe(1);
  expect(actionRenders).toBe(1);

  act(() => actions.clearInteractionDrafts());
  expect(state.pendingInteractionDrafts).toEqual([]);
  expect(actions).toBe(previousActions);
  expect(actionRenders).toBe(1);
  expect(structureRenders).toBe(1);

  act(() => {
    captured.dispatch?.({
      type: "SET_WORLD",
      world: {
        id: "world-1",
        name: "Harbor",
        description: "",
        createdAt: "2026-01-01T00:00:00Z",
      },
    });
  });
  expect(structure.world?.id).toBe("world-1");
  expect(structureRenders).toBe(2);
  expect(actionRenders).toBe(1);
});
