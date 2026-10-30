import { useReducer } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionActionKindsResponse } from "@covel/shared";
import * as api from "@/services/api";
import type { DataService, SessionWorkspace } from "@/services/data-service.js";
import { useBuildSessionActions } from "../actions.js";
import { initialState, reducer } from "../reducer.js";
import { createSseEventHandler } from "../sse-handler.js";
import { useSessionRuntimeRefs } from "../runtime-refs.js";

const session: api.SessionRecord = {
  id: "session-1",
  worldId: "world-1",
  status: "active",
  phase: "playing",
  completedPlayerTurns: 1,
  setupRuntimes: {},
  seats: [
    { id: "main", controller: "human", role: "player", characters: "auto" },
  ],
  activePlugins: [],
  locale: "en-US",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const catalogue = (kinds: string[]): SessionActionKindsResponse => ({
  kinds: kinds.map((kind) => ({
    kind,
    roles: ["player"],
    text: "required",
    actor: true,
    source: "framework",
    display: { label: kind },
  })),
  seats: [
    { seatId: "main", role: "player", controller: "human", allowed: kinds },
  ],
});

const workspace: SessionWorkspace = {
  run: (_id, _request, mutate) => mutate(),
  hydrate: vi.fn(),
  checkpoint: vi.fn(),
};

function renderActions() {
  const ds = {} as DataService;
  return renderHook(() => {
    const [state, dispatch] = useReducer(reducer, { ...initialState, session });
    const refs = useSessionRuntimeRefs(state);
    const handleSseEvent = createSseEventHandler({ ...refs, dispatch, ds });
    return {
      state,
      actions: useBuildSessionActions({
        state,
        dispatch,
        ds,
        workspace,
        refs,
        handleSseEvent,
      }),
    };
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, "listSessionPlugins").mockResolvedValue({
    items: [],
    commands: [],
    unavailable: [],
  } as unknown as Awaited<ReturnType<typeof api.listSessionPlugins>>);
});

describe("session action-kind catalogue", () => {
  it("is empty until the session's plugins are loaded, then holds the catalogue", async () => {
    vi.spyOn(api, "getSessionActionKinds").mockResolvedValue(
      catalogue(["say", "act"]),
    );
    const { result } = renderActions();
    expect(result.current.state.sessionActionKinds).toBeNull();
    await act(async () => result.current.actions.loadSessionPlugins());
    expect(api.getSessionActionKinds).toHaveBeenCalledWith("session-1");
    expect(
      result.current.state.sessionActionKinds?.kinds.map((k) => k.kind),
    ).toEqual(["say", "act"]);
  });

  it("is read again whenever the plugins are", async () => {
    const read = vi
      .spyOn(api, "getSessionActionKinds")
      .mockResolvedValueOnce(catalogue(["say"]))
      .mockResolvedValueOnce(catalogue(["say", "act"]));
    const { result } = renderActions();
    await act(async () => result.current.actions.loadSessionPlugins());
    await act(async () => result.current.actions.loadSessionPlugins());
    expect(read).toHaveBeenCalledTimes(2);
    expect(
      result.current.state.sessionActionKinds?.kinds.map((k) => k.kind),
    ).toEqual(["say", "act"]);
  });

  it("stays empty when the read fails, without touching the plugin list", async () => {
    vi.spyOn(api, "getSessionActionKinds").mockRejectedValue(
      new Error("offline"),
    );
    const { result } = renderActions();
    await act(async () => result.current.actions.loadSessionPlugins());
    await waitFor(() => expect(api.listSessionPlugins).toHaveBeenCalled());
    expect(result.current.state.sessionActionKinds).toBeNull();
    expect(result.current.state.sessionCommandsLoaded).toBe(true);
  });

  it("keeps the plugin list when only the plugin read fails", async () => {
    vi.spyOn(api, "listSessionPlugins").mockRejectedValue(new Error("offline"));
    vi.spyOn(api, "getSessionActionKinds").mockResolvedValue(
      catalogue(["say"]),
    );
    const { result } = renderActions();
    await act(async () => result.current.actions.loadSessionPlugins());
    expect(result.current.state.sessionActionKinds).not.toBeNull();
    expect(result.current.state.sessionCommandsLoaded).toBe(false);
  });
});
