import { useReducer } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Seat } from "@covel/shared";
import * as api from "@/services/api";
import type { DataService, SessionWorkspace } from "@/services/data-service.js";
import { useBuildSessionActions } from "../actions.js";
import { initialState, reducer } from "../reducer.js";
import { createSseEventHandler } from "../sse-handler.js";
import { useSessionRuntimeRefs } from "../runtime-refs.js";

afterEach(() => vi.restoreAllMocks());

function session(id: string): api.SessionRecord {
  return {
    id,
    worldId: "world",
    status: "active",
    phase: "playing",
    autoAdvanceLimit: 3,
    completedPlayerTurns: 1,
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: [],
    locale: "en-US",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
}
function seats(characterId: string): { seats: Seat[] } {
  return {
    seats: [
      {
        id: "main",
        controller: "human",
        role: "player",
        characters: "auto",
        currentCharacterId: characterId,
      },
    ],
  };
}
function fixture() {
  const initial = session("session-a");
  const workspace: SessionWorkspace = {
    run: (_id, _request, mutate) => mutate(),
    hydrate: vi.fn(),
    checkpoint: vi.fn(),
  };
  const switches: Array<{
    resolve: (value: { seats: Seat[] }) => void;
    reject: (error: Error) => void;
  }> = [];
  const setCharacter = vi
    .spyOn(api, "setSeatCurrentCharacter")
    .mockImplementation(
      () =>
        new Promise((resolve, reject) => switches.push({ resolve, reject })),
    );
  vi.spyOn(api, "getSession").mockResolvedValue(initial);
  const send = vi
    .spyOn(api, "sendAction")
    .mockImplementation(() => new AbortController());
  const hook = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, {
      ...initialState,
      session: initial,
      gameState: {
        characters: ["alice", "bob", "carol"].map((id) => ({
          id,
          name: id,
          type: "player",
        })),
      },
    });
    const refs = useSessionRuntimeRefs(state);
    return {
      state,
      dispatch,
      actions: useBuildSessionActions({
        state,
        dispatch,
        refs,
        workspace,
        ds: {} as DataService,
        handleSseEvent: createSseEventHandler({ ...refs, dispatch }),
      }),
    };
  });
  const enter = (id: string, characterId: string) =>
    act(() => {
      hook.result.current.actions.resetSession();
      hook.result.current.dispatch({
        type: "SET_SESSION",
        session: session(id),
      });
      hook.result.current.dispatch({
        type: "SET_GAME_STATE",
        state: {
          characters: [{ id: characterId, name: characterId, type: "player" }],
        },
      });
    });
  return { ...hook, setCharacter, send, switches, enter };
}

it("serializes remote switches and sends with the last chosen character", async () => {
  const f = fixture();
  let first!: Promise<void>, second!: Promise<void>;
  act(() => {
    first = f.result.current.actions.switchSeatCharacter("main", "bob");
    second = f.result.current.actions.switchSeatCharacter("main", "carol");
    expect(f.result.current.actions.sendMessage("Go")).toBe(true);
  });
  expect(f.setCharacter).toHaveBeenCalledTimes(1);
  expect(f.send).not.toHaveBeenCalled();
  await act(async () => {
    f.switches[0]!.resolve(seats("bob"));
    await first;
  });
  expect(f.setCharacter).toHaveBeenCalledTimes(2);
  expect(f.send).not.toHaveBeenCalled();
  await act(async () => {
    f.switches[1]!.resolve(seats("carol"));
    await second;
  });
  expect(f.result.current.state.session?.seats[0]?.currentCharacterId).toBe(
    "carol",
  );
  expect(f.result.current.state.messages[0]?.actions?.[0]?.actorId).toBe(
    "carol",
  );
  expect(f.send).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "does not borrow the previous session's switch (delayed: %s)",
  async (delayed) => {
    const f = fixture();
    let switching!: Promise<void>;
    act(() => {
      switching = f.result.current.actions.switchSeatCharacter("main", "alice");
    });
    if (!delayed)
      await act(async () => {
        f.switches[0]!.resolve(seats("alice"));
        await switching;
      });
    f.enter("session-b", "bob");
    act(() => {
      expect(f.result.current.actions.sendMessage("Hello from B")).toBe(true);
    });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.result.current.state.messages[0]?.actions?.[0]?.actorId).toBe(
      "bob",
    );
    if (delayed)
      await act(async () => {
        f.switches[0]!.resolve(seats("alice"));
        await switching;
      });
    expect(f.result.current.state.session?.id).toBe("session-b");
    expect(
      f.result.current.state.session?.seats[0]?.currentCharacterId,
    ).toBeUndefined();
    expect(f.result.current.state.messages[0]?.actions?.[0]?.actorId).toBe(
      "bob",
    );
  },
);

it("keeps new-session switches independent and ignores responses for another session", async () => {
  const f = fixture();
  let old!: Promise<void>, current!: Promise<void>;
  act(() => {
    old = f.result.current.actions.switchSeatCharacter("main", "alice");
  });
  f.enter("session-b", "bob");
  act(() => {
    current = f.result.current.actions.switchSeatCharacter("main", "bob");
  });
  expect(f.setCharacter).toHaveBeenCalledTimes(2);
  await act(async () => {
    f.switches[1]!.resolve(seats("bob"));
    await current;
  });
  await act(async () => {
    f.switches[0]!.resolve(seats("alice"));
    await old;
  });
  expect(f.result.current.state.session?.seats[0]?.currentCharacterId).toBe(
    "bob",
  );
});

it("waits for switches added while input is waiting, including a failed final switch", async () => {
  const f = fixture();
  let first!: Promise<void>, failed!: Promise<unknown>;
  act(() => {
    first = f.result.current.actions.switchSeatCharacter("main", "bob");
    expect(f.result.current.actions.sendMessage("Go")).toBe(true);
    failed = f.result.current.actions
      .switchSeatCharacter("main", "carol")
      .catch((error) => error);
  });
  await act(async () => {
    f.switches[0]!.resolve(seats("bob"));
    await first;
  });
  expect(f.send).not.toHaveBeenCalled();
  await act(async () => {
    f.switches[1]!.reject(new Error("Switch refused"));
    await failed;
  });
  expect(f.result.current.state.messages[0]?.actions?.[0]?.actorId).toBe("bob");
  expect(f.send).toHaveBeenCalledOnce();
});

it("continues queued switches after a rejection", async () => {
  const f = fixture();
  let failed!: Promise<unknown>, next!: Promise<void>;
  act(() => {
    failed = f.result.current.actions
      .switchSeatCharacter("main", "bob")
      .catch((error) => error);
    next = f.result.current.actions.switchSeatCharacter("main", "carol");
  });
  expect(f.setCharacter).toHaveBeenCalledTimes(1);
  await act(async () => {
    f.switches[0]!.reject(new Error("Switch refused"));
    await failed;
  });
  expect(f.setCharacter).toHaveBeenCalledTimes(2);
  await act(async () => {
    f.switches[1]!.resolve(seats("carol"));
    await next;
  });
  expect(f.result.current.state.session?.seats[0]?.currentCharacterId).toBe(
    "carol",
  );
});

it("applies a completed switch when returning to the same session", async () => {
  const f = fixture();
  let switching!: Promise<void>;
  act(() => {
    switching = f.result.current.actions.switchSeatCharacter("main", "bob");
  });
  f.enter("session-b", "carol");
  f.enter("session-a", "alice");
  act(() =>
    f.result.current.dispatch({
      type: "SET_GAME_STATE",
      state: {
        characters: ["alice", "bob"].map((id) => ({
          id,
          name: id,
          type: "player",
        })),
      },
    }),
  );
  await act(async () => {
    f.switches[0]!.resolve(seats("bob"));
    await switching;
  });
  expect(f.result.current.state.session?.seats[0]?.currentCharacterId).toBe(
    "bob",
  );
  act(() => {
    expect(f.result.current.actions.sendMessage("Go")).toBe(true);
  });
  expect(f.result.current.state.messages[0]?.actions?.[0]?.actorId).toBe("bob");
  expect(f.send).toHaveBeenCalledOnce();
});
