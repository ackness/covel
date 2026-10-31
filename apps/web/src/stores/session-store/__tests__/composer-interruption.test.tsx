import { useReducer, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "i18next";
import * as api from "@/services/api.js";
import { emitToast } from "@/lib/toast-channel.js";
import { useGameViewComposer } from "@/components/session/game-view/use-game-view-composer.js";
import { createSessionWorkspace } from "@/services/data-service/workspace.js";
import type { DataService } from "@/services/data-service.js";
import {
  SessionActionsContext,
  SessionStateContext,
  useSession,
} from "../context.js";
import { initialState, reducer } from "../reducer.js";
import { useSessionRuntimeRefs } from "../runtime-refs.js";
import { useBuildSessionActions } from "../actions.js";
import { createSseEventHandler } from "../sse-handler.js";

vi.mock("@/lib/toast-channel.js", () => ({ emitToast: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["player say", "host say", "structured action"])(
  "keeps a second %s draft through the abort response and checkpoint",
  async (surface) => {
    const abort = deferred<boolean>();
    const checkpoint = deferred<void>();
    const ds = {} as DataService;
    const workspace = createSessionWorkspace(ds, "remote");
    const settle = vi
      .spyOn(workspace, "settle")
      .mockReturnValue(checkpoint.promise);
    const stop = vi.spyOn(api, "abortTurn").mockReturnValue(abort.promise);
    const send = vi
      .spyOn(api, "sendAction")
      .mockImplementation(() => new AbortController());
    const session: api.SessionRecord = {
      id: "session",
      worldId: "world",
      status: "active",
      phase: "playing",
      locale: "en-US",
      autoAdvanceLimit: 3,
      completedPlayerTurns: 1,
      setupRuntimes: {},
      seats: [
        {
          id: "human",
          role: surface === "player say" ? "player" : "host",
          controller: "human",
          characters: "auto",
        },
      ],
      activePlugins: [],
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    };
    let dispatch!: React.Dispatch<Parameters<typeof reducer>[1]>;
    function Wrapper({ children }: { children: ReactNode }) {
      const [state, update] = useReducer(reducer, {
        ...initialState,
        session,
        executing: true,
        advance: {
          requestId: "root",
          rootId: "root",
          phase: "running",
          round: 1,
          limit: 3,
        },
        sessionActionKinds: {
          kinds: [
            {
              kind: "say",
              display: { label: "Say" },
              source: "framework",
              roles: ["player", "host"],
              text: "required",
              actor: true,
            },
            {
              kind: "p/order",
              display: { label: "Order" },
              source: "plugin",
              pluginId: "p",
              roles: ["host"],
              text: "optional",
              actor: false,
              fieldsSchema: {
                type: "object",
                properties: { target: { type: "string" } },
              },
            },
          ],
          seats: [
            {
              seatId: "human",
              role: session.seats[0]!.role,
              controller: "human",
              allowed: ["say", "p/order"],
            },
          ],
        },
      });
      dispatch = update;
      const refs = useSessionRuntimeRefs(state);
      const handleSseEvent = createSseEventHandler({
        ...refs,
        dispatch: update,
        ds,
      });
      const actions = useBuildSessionActions({
        state,
        dispatch: update,
        ds,
        workspace,
        refs,
        handleSseEvent,
      });
      return (
        <SessionStateContext value={state}>
          <SessionActionsContext value={actions}>
            {children}
          </SessionActionsContext>
        </SessionStateContext>
      );
    }
    const h = renderHook(
      () => {
        const { state, sendMessage } = useSession();
        return useGameViewComposer({
          messages: state.messages,
          submittedBlockIds: state.submittedBlockIds,
          executing: state.executing,
          session,
          onSendMessage: sendMessage,
        });
      },
      { wrapper: Wrapper },
    );
    try {
      act(() => h.result.current.setInputValue("First input"));
      act(() => h.result.current.handleSubmit());
      expect(h.result.current.inputValue).toBe("");
      expect(stop).toHaveBeenCalledOnce();
      const selection = {
        id: "selection",
        turnId: "earlier",
        interactionId: "suggestion",
        type: "suggestion" as const,
        label: "Look around",
        values: { text: "Look around" },
      };
      act(() => {
        dispatch({ type: "UPSERT_DRAFT", draft: selection });
        h.result.current.setInputValue("Second input");
        if (surface === "structured action")
          h.result.current.composerModes.selectKind("p/order");
      });
      if (surface === "structured action")
        act(() =>
          h.result.current.composerModes.setFieldValue("target", "Gate"),
        );
      act(() => h.result.current.handleSubmit());
      expect(h.result.current.inputValue).toBe("Second input");
      expect(h.result.current.pendingDrafts).toEqual([selection]);
      expect(emitToast).toHaveBeenCalledWith(
        "info",
        i18n.t("session.reasonSessionBusy"),
      );
      expect(send).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledOnce();
      await act(async () => {
        dispatch({ type: "SET_ADVANCE", advance: null });
        dispatch({ type: "SET_EXECUTING", value: false });
        abort.resolve(true);
      });
      expect(settle).toHaveBeenCalledOnce();
      act(() => h.result.current.handleSubmit());
      expect(h.result.current.inputValue).toBe("Second input");
      expect(h.result.current.pendingDrafts).toEqual([selection]);
      if (surface === "structured action")
        expect(h.result.current.composerModes.fieldValues).toEqual({
          target: "Gate",
        });
      expect(send).not.toHaveBeenCalled();
      await act(async () => checkpoint.resolve());
      await waitFor(() => expect(send).toHaveBeenCalledOnce());
      expect(send.mock.calls[0]?.[0]).toMatchObject({
        payload: { actions: [{ kind: "say", text: "First input" }] },
      });
      expect(h.result.current.inputValue).toBe("Second input");
      expect(h.result.current.pendingDrafts).toEqual([selection]);
    } finally {
      await act(async () => {
        abort.resolve(true);
        checkpoint.resolve();
      });
      h.unmount();
    }
  },
);
