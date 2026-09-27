import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionWorkspace } from "@/services/data-service.js";
import type {
  ConnectionState,
  SubscriptionEvent,
} from "@/services/subscription.js";
import { clearUiSlots, useUiSlots } from "../ui-slot-store.js";
import { initialState } from "../session-store/reducer.js";
import { useSessionSubscription } from "../session-store/subscription.js";

const stream = vi.hoisted(() => ({
  onEvent: undefined as ((event: unknown) => void) | undefined,
  onStateChange: undefined as ((state: unknown) => void) | undefined,
}));
const request = vi.hoisted(() => vi.fn());
vi.mock("@/services/api/request.js", () => ({ request }));
vi.mock("@/services/subscription.js", () => ({
  createSessionSubscription: vi.fn(
    (
      _sessionId: string,
      options: { onStateChange: (state: unknown) => void },
    ) => {
      stream.onStateChange = options.onStateChange;
      return {
        state: "connecting",
        on: (_topic: string, handler: (event: unknown) => void) => {
          stream.onEvent = handler;
        },
        off: vi.fn(),
        close: vi.fn(),
      };
    },
  ),
}));
vi.mock("@/services/api", () => ({
  getSessionView: vi.fn(async () => ({
    session: { id: "s", worldId: "w", phase: "playing" },
    messages: [],
    characters: [],
    gameState: {},
    executionSteps: [],
    plugins: [],
  })),
  getWorld: vi.fn(async () => ({ id: "w", name: "World" })),
  listPluginData: vi.fn(async () => []),
  listSessionPlugins: vi.fn(async () => ({ commands: [], items: [] })),
  listSuspensions: vi.fn(async () => []),
}));

const slot = (name: string) => ({
  slot: "stage.backdrop@1",
  value: { name, pending: false },
  revision: name,
});
const event = (type: string, payload: Record<string, unknown> = {}) =>
  ({
    id: type,
    topic: "system",
    type,
    sessionId: "s",
    timestamp: "2026-09-28T00:00:00.000Z",
    payload,
  }) as SubscriptionEvent;
const emit = (type: string, payload?: Record<string, unknown>) =>
  stream.onEvent?.(event(type, payload));
const connect = (state: ConnectionState) => stream.onStateChange?.(state);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const sessionIdRef = { current: "s" };
  const sessionGenerationRef = { current: 0 };
  const dispatch = vi.fn();
  const workspace = {
    checkpoint: vi.fn(async () => {}),
  } as unknown as SessionWorkspace;
  const activeTurnIdRef = { current: null };
  const stateRef = {
    current: {
      ...initialState,
      session: {
        id: "s",
        worldId: "w",
        phase: "playing" as const,
        status: "active" as const,
        locale: "en-US",
        activePlugins: [],
        setupRuntimes: {},
        completedPlayerTurns: 0,
        createdAt: "now",
        updatedAt: "now",
      },
    },
  };
  return renderHook(() => {
    const slots = useUiSlots("s");
    useSessionSubscription({
      sessionId: "s",
      dispatch,
      workspace,
      sessionIdRef,
      sessionGenerationRef,
      stateRef,
      activeTurnIdRef,
    });
    return slots;
  });
}

beforeEach(() => {
  clearUiSlots();
  request.mockReset();
  stream.onEvent = undefined;
  stream.onStateChange = undefined;
});
afterEach(() => cleanup());

it("resets visible slots through the durable subscription and rejects old GET results", async () => {
  const beforeReset = deferred<{ items: ReturnType<typeof slot>[] }>();
  const afterReset = deferred<{ items: ReturnType<typeof slot>[] }>();
  request
    .mockReturnValueOnce(beforeReset.promise)
    .mockReturnValueOnce(afterReset.promise);
  const { result } = setup();
  await waitFor(() => expect(stream.onEvent).toBeDefined());

  act(() => {
    emit("ui.slot.changed", slot("committed"));
    emit("ui.slot.preview", { ...slot("preview"), turnId: "old-turn" });
  });
  expect(result.current[0]?.value).toMatchObject({ name: "preview" });

  act(() => emit("system.reset"));
  expect(result.current).toEqual([]);
  expect(request).toHaveBeenCalledTimes(2);

  await act(async () =>
    beforeReset.resolve({ items: [slot("stale-before-reset")] }),
  );
  expect(result.current).toEqual([]);

  act(() => emit("ui.slot.changed", slot("live-after-reset")));
  await waitFor(() =>
    expect(result.current[0]?.value).toMatchObject({
      name: "live-after-reset",
    }),
  );
  await act(async () =>
    afterReset.resolve({ items: [slot("stale-snapshot")] }),
  );
  expect(result.current[0]?.value).toMatchObject({ name: "live-after-reset" });
  act(() =>
    emit("ui.slot.preview", { ...slot("obsolete"), turnId: "old-turn" }),
  );
  expect(result.current[0]?.value).toMatchObject({ name: "live-after-reset" });
});

it("refreshes committed slots after the durable connection resumes", async () => {
  request
    .mockResolvedValueOnce({ items: [slot("initial")] })
    .mockResolvedValueOnce({ items: [slot("reconnected")] });
  const { result } = setup();
  await waitFor(() =>
    expect(result.current[0]?.value).toMatchObject({ name: "initial" }),
  );
  act(() => {
    connect("connected");
    connect("reconnecting");
    connect("connected");
  });
  await waitFor(() =>
    expect(result.current[0]?.value).toMatchObject({ name: "reconnected" }),
  );
  expect(request).toHaveBeenCalledTimes(2);
});
