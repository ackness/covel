import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionSnapshot, StoryMessageSegment } from "@covel/shared";
import type { SessionWorkspace } from "@/services/data-service.js";
import type {
  SessionSubscriptionOptions,
  SubscriptionEvent,
  SubscriptionEventHandler,
} from "@/services/subscription.js";
import { StoryOperationFailureNotice } from "@/components/session/chat-messages/story-operation-failure-notice.js";
import { initialState, reducer } from "../reducer.js";
import {
  applyResumeEvents,
  createSseEventHandler,
  type SseEventHandlerDeps,
} from "../sse-handler.js";
import type { SessionAction, SessionState } from "../types.js";
import { suspendedStory } from "./helpers/suspended-story.js";

const api = vi.hoisted(() => ({ getSessionView: vi.fn() }));
const subscription = vi.hoisted(() => ({ createSessionSubscription: vi.fn() }));
vi.mock("@/services/api", () => api);
vi.mock("@/services/subscription.js", () => subscription);
const { rehydrateSessionSideState, useSessionSubscription } =
  await import("../subscription.js");

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

function observer(session: NonNullable<SessionState["session"]>) {
  let emit: SubscriptionEventHandler = () => {};
  subscription.createSessionSubscription.mockImplementation(
    (_id: string, _options: SessionSubscriptionOptions) => ({
      close: vi.fn(),
      alignWithSnapshot: vi.fn(),
      on: (_topic: string, handler: SubscriptionEventHandler) => {
        emit = handler;
      },
    }),
  );
  const stateRef = { current: { ...initialState, session } as SessionState };
  const dispatch = vi.fn((action: SessionAction) => {
    stateRef.current = reducer(stateRef.current, action);
  });
  const options = {
    sessionId: session.id,
    sessionIdRef: { current: session.id as string | null },
    sessionGenerationRef: { current: 1 },
    stateRef,
    dispatch,
    activeTurnIdRef: { current: null as string | null },
    deltaBufferRef: { current: new Map() },
    deltaRafRef: { current: null },
    storageMode: "remote" as const,
    workspace: {
      hydrate: vi.fn(),
      run: vi.fn(),
      checkpoint: vi.fn(),
    } satisfies SessionWorkspace,
  };
  const hook = renderHook(() => useSessionSubscription(options));
  return { ...hook, options, emit: (event: SubscriptionEvent) => emit(event) };
}

it.each(["recovery first", "resume first"])(
  "keeps the recovered notice and footer after resume replay: %s",
  async (order) => {
    const timestamp = "2026-10-31T00:00:00.000Z";
    const segments: StoryMessageSegment[] = [
      { kind: "narration", text: "The guide speaks." },
    ];
    const message = {
      id: "saved-story",
      role: "assistant" as const,
      kind: "story",
      turnId: "turn",
      runtimeId: "teller/story",
      content: segments[0]!.text,
      segments,
      createdAt: timestamp,
      operationFailures: { count: 1 },
    };
    const session: NonNullable<SessionState["session"]> = {
      id: "session",
      worldId: "",
      locale: "en-US",
      status: "active",
      phase: "playing",
      setupRuntimes: {},
      seats: [],
      activePlugins: [],
      completedPlayerTurns: 1,
      autoAdvanceLimit: 3,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    api.getSessionView.mockResolvedValue({
      session,
      messages: [message],
      characters: [],
      dimensions: {},
      plugins: [],
      executionSteps: [],
      submittedInteractions: [],
      execution: { state: "idle" },
    } satisfies SessionSnapshot);
    const { options } = observer(session);
    const handle = createSseEventHandler({
      ...options,
      ds: {} as SseEventHandlerDeps["ds"],
      lastBackfilledTurnIdRef: { current: null },
    });
    const replay = () =>
      applyResumeEvents(
        [
          {
            id: "completion",
            type: "narrative.completed",
            sessionId: session.id,
            turnId: message.turnId,
            timestamp,
            source: { pluginId: "teller", runtimeId: message.runtimeId },
            payload: {
              messageId: message.id,
              kind: "story",
              content: message.content,
              segments,
            },
          },
        ],
        handle,
      );
    if (order === "resume first") replay();
    await rehydrateSessionSideState(
      session.id,
      options.sessionIdRef,
      options.dispatch,
      () => true,
      options,
      "state",
    );
    if (order === "recovery first") replay();
    const messages = options.stateRef.current.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: message.id,
      content: message.content,
      segments,
      operationFailures: { count: 1 },
    });
    render(<StoryOperationFailureNotice message={messages[0]!} />);
    expect(
      screen.getByTestId("story-operation-failure-notice").textContent,
    ).toBe("本回合有 1 个操作没有生效。");
  },
);

it.each([false, true])(
  "loads a committed story and notice for an idle observer while a system runtime stays suspended (manual parent: %s)",
  async (manual) => {
    const fixture = await suspendedStory(manual);
    try {
      api.getSessionView.mockImplementation(fixture.view);
      const { options, emit } = observer(fixture.session);
      const events: SubscriptionEvent[] = [];
      const topics: readonly string[] =
        subscription.createSessionSubscription.mock.calls[0]![1].topics;
      fixture.eventBus.onEmit((event) => {
        if (topics.includes(event.topic)) events.push(event);
      });
      expect(api.getSessionView).not.toHaveBeenCalled();
      const outcome = await fixture.commit();
      expect(outcome.status).toBe("committed");
      expect(outcome.operations).toMatchObject([
        { status: "failed", reason: "rejected" },
      ]);
      // Execution progress carries no saved messages. Suspension is the only
      // commit notification; no unrelated state write can mask a missed read.
      expect(
        events
          .map((event) => event.type)
          .filter(
            (type) =>
              ![
                "turn.started",
                "runtime.started",
                "runtime.completed",
              ].includes(type),
          ),
      ).toEqual(["turn.suspended"]);
      expect(await fixture.store.listPluginData("session", "provider")).toEqual(
        [],
      );
      await act(async () => {
        for (const event of events) emit(event);
      });
      expect(api.getSessionView).toHaveBeenCalledOnce();
      const state = options.stateRef.current;
      expect(state.messages).toEqual([
        expect.objectContaining({
          content: "The guide waits for your answer.",
          operationFailures: { count: 1 },
        }),
      ]);
      const [suspension] = await fixture.store.listSuspensions("session");
      expect(suspension?.resolvedAt).toBeUndefined();
      expect(state.suspensions).toEqual([
        expect.objectContaining({ id: suspension!.id }),
      ]);
      expect(state.session?.completedPlayerTurns).toBe(0);
      expect(options.workspace.run).not.toHaveBeenCalled();
      render(<StoryOperationFailureNotice message={state.messages[0]!} />);
      expect(
        screen.getAllByTestId("story-operation-failure-notice"),
      ).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  },
);
