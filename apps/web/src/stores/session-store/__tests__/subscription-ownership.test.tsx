import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { SessionWorkspace } from "@/services/data-service.js";
import type {
  ConnectionState,
  SessionSubscriptionOptions,
  SubscriptionEvent,
  SubscriptionEventHandler,
} from "@/services/subscription.js";
import type { SessionPlugin, WorldRecord } from "@/services/api.js";
import { initialState } from "../reducer.js";
import type { SessionState } from "../types.js";

const api = vi.hoisted(() => ({
  listSessionPlugins: vi.fn(),
  listPluginData: vi.fn(),
  getWorld: vi.fn(),
  getSessionView: vi.fn(),
  listSuspensions: vi.fn(),
}));
const subscription = vi.hoisted(() => ({ createSessionSubscription: vi.fn() }));
const connection = vi.hoisted(() => ({ setConnectionState: vi.fn() }));
vi.mock("@/services/api", () => api);
vi.mock("@/services/subscription.js", () => subscription);
vi.mock("@/stores/connection-store.js", () => connection);
vi.mock("@/stores/plugin-data-store.js", () => ({
  replaceSessionPluginData: vi.fn(),
}));
const { useSessionSubscription } = await import("../subscription.js");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const session = {
  id: "session",
  worldId: "world",
  incarnation: "incarnation",
  locale: "en-US",
  status: "active" as const,
  phase: "playing" as const,
  completedPlayerTurns: 1,
  setupRuntimes: {},
  activePlugins: [],
  createdAt: "2026-09-19T00:00:00Z",
  updatedAt: "2026-09-19T00:00:00Z",
};
const world: WorldRecord = {
  id: "world",
  name: "Current",
  description: "",
  createdAt: session.createdAt,
};
const plugins = (id: string) => ({
  items: [{ id, active: true } as SessionPlugin],
  commands: [],
});

function setup() {
  const streams: {
    emit: SubscriptionEventHandler;
    state: (state: ConnectionState) => void;
  }[] = [];
  subscription.createSessionSubscription.mockImplementation(
    (_id: string, options: SessionSubscriptionOptions) => {
      const stream = {
        emit: (() => {}) as SubscriptionEventHandler,
        state: options.onStateChange!,
      };
      streams.push(stream);
      return {
        close: vi.fn(),
        on: (_topic: string, handler: SubscriptionEventHandler) => {
          stream.emit = handler;
        },
      };
    },
  );
  const options = {
    sessionId: session.id,
    sessionIdRef: { current: session.id as string | null },
    sessionGenerationRef: { current: 1 },
    stateRef: { current: { ...initialState, session } as SessionState },
    activeTurnIdRef: { current: null },
    workspace: {} as SessionWorkspace,
    dispatch: vi.fn(),
  };
  const hook = renderHook(() => useSessionSubscription(options));
  return { ...hook, options, streams };
}

function event(type: string): SubscriptionEvent {
  return {
    type,
    id: type,
    topic: "plugin",
    sessionId: session.id,
    timestamp: session.createdAt,
    payload: { worldId: "world" },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.listSessionPlugins.mockResolvedValue(plugins("current"));
  api.listPluginData.mockResolvedValue([]);
  api.getWorld.mockResolvedValue(world);
  api.getSessionView.mockResolvedValue({
    session,
    messages: [],
    gameState: {},
    characters: [],
    executionSteps: [],
    execution: { state: "idle" },
  });
  api.listSuspensions.mockResolvedValue([]);
});

it.each(["plugin.activated", "world.dimensions.changed"])(
  "drops an older %s refresh after the latest refresh publishes",
  async (type) => {
    const pending = deferred<unknown>();
    const fetch =
      type === "plugin.activated" ? api.listSessionPlugins : api.getWorld;
    fetch.mockReturnValueOnce(pending.promise);
    const { streams, options } = setup();
    await act(async () => {
      streams[0]!.emit(event(type));
      streams[0]!.emit(event(type));
    });
    expect(options.dispatch).toHaveBeenCalledWith(
      type === "plugin.activated"
        ? {
            type: "LOAD_SESSION_PLUGINS",
            plugins: plugins("current").items,
            commands: [],
          }
        : { type: "UPDATE_WORLD", world },
    );
    options.dispatch.mockClear();
    await act(async () => {
      pending.resolve(
        type === "plugin.activated"
          ? plugins("obsolete")
          : { ...world, name: "Obsolete" },
      );
    });
    expect(options.dispatch).not.toHaveBeenCalled();
  },
);

it.each(["plugin.activated", "world.dimensions.changed"])(
  "drops %s responses from a previous visit to the same session",
  async (type) => {
    const pending = deferred<unknown>();
    (type === "plugin.activated"
      ? api.listSessionPlugins
      : api.getWorld
    ).mockReturnValueOnce(pending.promise);
    const { streams, options, rerender } = setup();
    streams[0]!.emit(event(type));
    options.sessionGenerationRef.current += 1;
    rerender();
    options.dispatch.mockClear();
    await act(async () => {
      pending.resolve(
        type === "plugin.activated"
          ? plugins("obsolete")
          : { ...world, name: "Obsolete" },
      );
    });
    expect(options.dispatch).not.toHaveBeenCalled();
  },
);

it("invalidates pending event refreshes when reconnect recovery starts", async () => {
  const pending = deferred<unknown>();
  api.listSessionPlugins.mockReturnValueOnce(pending.promise);
  const { streams, options } = setup();
  streams[0]!.emit(event("plugin.activated"));
  await act(async () => {
    streams[0]!.emit(event("system.reset"));
  });
  options.dispatch.mockClear();
  await act(async () => {
    pending.resolve(plugins("obsolete"));
  });
  expect(options.dispatch).not.toHaveBeenCalled();
});

it("ignores events and connection updates from a closed visit", () => {
  const { streams, options, rerender } = setup();
  options.sessionGenerationRef.current += 1;
  rerender();
  options.dispatch.mockClear();
  connection.setConnectionState.mockClear();
  streams[0]!.emit(event("turn.resumed"));
  streams[0]!.state("reconnecting");
  expect(options.dispatch).not.toHaveBeenCalled();
  expect(connection.setConnectionState).not.toHaveBeenCalled();
});

it("ignores pending event refreshes after provider unmount", async () => {
  const pending = deferred<unknown>();
  api.listSessionPlugins.mockReturnValueOnce(pending.promise);
  const { streams, options, unmount } = setup();
  streams[0]!.emit(event("plugin.activated"));
  unmount();
  await act(async () => {
    pending.resolve(plugins("obsolete"));
  });
  expect(options.dispatch).not.toHaveBeenCalled();
});
