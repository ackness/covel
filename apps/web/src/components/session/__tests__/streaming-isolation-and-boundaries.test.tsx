import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { memo, useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/index.js";
import { PluginWebview } from "../plugin-webview.js";
import { StageBackdrop } from "../stage/StageBackdrop.js";
import { RawJsonBlock } from "../chat-messages/message-primitives.js";
import {
  SessionStateContext,
  SessionStructureContext,
  useSessionStructure,
  type SessionStructureState,
} from "@/stores/session-store/context.js";
import {
  configureMessagesWindowCap,
  initialState,
  reducer,
} from "@/stores/session-store/reducer.js";
import { finalizeActionExecution } from "@/stores/session-store/runtime-rpc.js";
import type { SessionAction, SessionState } from "@/stores/session-store/types.js";

const connectPluginBridge = vi.hoisted(() => vi.fn());
vi.mock("../plugin-bridge.js", () => ({
  connectPluginBridge,
}));

vi.mock("@/components/Media.js", () => ({
  Media: ({ src }: { src: { id: string } }) => (
    <div data-testid={`media-${src.id}`} />
  ),
}));

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  connectPluginBridge.mockReset();
});

afterEach(() => {
  configureMessagesWindowCap(2000);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  cleanup();
});

describe("streaming render isolation and session boundaries", () => {
  it("keeps SessionStructureContext consumers from re-rendering during output draft and step streaming", () => {
    const renders = vi.fn();

    const StructureConsumer = memo(function StructureConsumer() {
      const structure = useSessionStructure();
      renders(structure.session?.id ?? null);
      return <div data-testid="structure-id">{structure.session?.id}</div>;
    });

    const baseSession = {
      id: "sess-1",
      worldId: "world-1",
      incarnation: "inc-1",
      locale: "en-US",
      status: "active" as const,
      phase: "playing" as const,
      autoAdvanceLimit: 3,
      completedPlayerTurns: 0,
      setupRuntimes: {},
      seats: [],
      activePlugins: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    let triggerStreamUpdate!: () => void;

    function Harness() {
      const [state, setState] = useState<SessionState>({
        ...initialState,
        session: baseSession,
      });
      triggerStreamUpdate = () =>
        setState((prev) =>
          reducer(
            reducer(prev, {
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
            }),
            {
              type: "UPSERT_EXECUTION_STEP",
              step: {
                turnId: "turn-1",
                runtimeId: "narrator",
                pluginId: "narrator",
                status: "running",
              },
            },
          ),
        );

      const structure = useMemo<SessionStructureState>(
        () => ({
          session: state.session,
          world: state.world,
          sessionPlugins: state.sessionPlugins,
          gameState: state.gameState,
        }),
        [state.session, state.world, state.sessionPlugins, state.gameState],
      );

      return (
        <SessionStructureContext.Provider value={structure}>
          <SessionStateContext.Provider value={state}>
            <StructureConsumer />
          </SessionStateContext.Provider>
        </SessionStructureContext.Provider>
      );
    }

    render(<Harness />);
    expect(renders).toHaveBeenCalledTimes(1);

    act(() => {
      triggerStreamUpdate();
    });
    expect(renders).toHaveBeenCalledTimes(1);
  });

  it.each([
    "//evil.example/plugin.html",
    "/api/health",
    "/plugin-assets/demo/../../etc/passwd",
    "/plugin-assets/demo/\nindex.html",
  ])("fails closed on unsafe PluginWebview src %s without probing or connecting", (unsafeSrc) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <PluginWebview
        title="Unsafe View"
        src={unsafeSrc}
        state={{}}
        locked={false}
        handlers={{}}
      />,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(connectPluginBridge).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Retry|Reload/i })).toBeTruthy();
  });

  it("unmounts the previous StageBackdrop layer once the crossfade completes", () => {
    vi.useFakeTimers();
    const frame1 = {
      id: "frame-1",
      kind: "image" as const,
      mime: "image/png",
      sha256: "a".repeat(64),
      size: 128,
    };
    const frame2 = {
      id: "frame-2",
      kind: "image" as const,
      mime: "image/png",
      sha256: "b".repeat(64),
      size: 128,
    };
    const { rerender } = render(
      <StageBackdrop
        sessionId="sess-1"
        world={null}
        sceneCurrent={{
          ref: frame1,
        }}
      />,
    );
    expect(screen.getByTestId("media-frame-1")).toBeTruthy();

    rerender(
      <StageBackdrop
        sessionId="sess-1"
        world={null}
        sceneCurrent={{
          ref: frame2,
        }}
      />,
    );
    expect(screen.getByTestId("media-frame-1")).toBeTruthy();
    expect(screen.getByTestId("media-frame-2")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(650);
    });
    expect(screen.queryByTestId("media-frame-1")).toBeNull();
    expect(screen.getByTestId("media-frame-2")).toBeTruthy();
  });

  it("prunes submitted blocks and plugin message data when live message window caps old entries", () => {
    configureMessagesWindowCap(200);
    const messages = Array.from({ length: 200 }, (_, i) => ({
      id: `m-${i}`,
      role: "assistant" as const,
      content: `Line ${i}`,
      turnId: `t-${i}`,
      timestamp: "2026-01-01T00:00:00Z",
    }));

    const populated: SessionState = {
      ...initialState,
      messages,
      submittedBlockIds: new Set(["m-0", "m-199"]),
      submittedBlockValues: {
        "m-0": { choice: "old" },
        "m-199": { choice: "keep" },
      },
      pluginMessageData: {
        notes: {
          "entry-0": { __turnId: "t-0", text: "old" },
          "entry-199": { __turnId: "t-199", text: "keep" },
        },
      },
    };

    const next = reducer(populated, {
      type: "ADD_MESSAGE",
      message: {
        id: "m-200",
        role: "assistant",
        content: "Latest",
        turnId: "t-200",
        timestamp: "2026-01-01T00:00:01Z",
      },
    });

    expect(next.messages).toHaveLength(200);
    expect(next.messages[0]?.id).toBe("m-1");
    expect(next.submittedBlockIds.has("m-0")).toBe(false);
    expect(next.submittedBlockIds.has("m-199")).toBe(true);
    expect(next.submittedBlockValues["m-0"]).toBeUndefined();
    expect(next.submittedBlockValues["m-199"]).toEqual({ choice: "keep" });
    expect(next.pluginMessageData.notes).toEqual({
      "entry-199": { __turnId: "t-199", text: "keep" },
    });
  });

  it("clears stale auto-advance progress when finalizeActionExecution tears down a stream", () => {
    const actions: SessionAction[] = [];
    finalizeActionExecution(
      (action) => actions.push(action),
      "sess-1",
      { current: "sess-1" },
    );
    expect(actions).toContainEqual({ type: "SET_ADVANCE", advance: null });
    expect(actions).toContainEqual({ type: "SET_EXECUTING", value: false });
  });

  it("handles missing or rejected clipboard APIs without setting copied state in RawJsonBlock", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new Error("Clipboard denied")),
      },
    });

    render(<RawJsonBlock content='{"ok":true}' />);
    const copyBtn = screen.getByRole("button", { name: "Copy" });
    fireEvent.click(copyBtn);
    await act(async () => {
      await Promise.resolve();
    });
    expect(copyBtn.querySelector(".text-green-500")).toBeNull();
  });
});
