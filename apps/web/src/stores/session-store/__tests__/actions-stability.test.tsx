import { act, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  SessionProvider,
  useSession,
  useSessionActions,
} from "../../session-store.js";
import type { SessionActions } from "../context.js";
import type { SessionState } from "../types.js";

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
vi.mock("../subscription.js", () => ({ useSessionSubscription: () => {} }));

it("keeps actual provider actions stable when reducer state changes", () => {
  let actions!: SessionActions;
  let state!: SessionState;
  let actionRenders = 0;
  function ActionsConsumer() {
    actions = useSessionActions();
    actionRenders += 1;
    return null;
  }
  function StateConsumer() {
    state = useSession().state;
    return null;
  }
  render(
    <SessionProvider>
      <ActionsConsumer />
      <StateConsumer />
    </SessionProvider>,
  );
  const previous = actions;
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
  expect(actions).toBe(previous);
  expect(actionRenders).toBe(1);
  act(() => actions.clearInteractionDrafts());
  expect(state.pendingInteractionDrafts).toEqual([]);
  expect(actions).toBe(previous);
  expect(actionRenders).toBe(1);
});
