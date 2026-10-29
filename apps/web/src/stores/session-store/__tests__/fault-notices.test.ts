// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import * as api from "@/services/api.js";
import { subscribeToast } from "@/lib/toast-channel.js";
import { initialState } from "../reducer.js";
import {
  createSseEventHandler,
  type SseEventHandlerDeps,
} from "../sse-handler.js";
import { createSubscriptionEventHandler } from "../subscription.js";

vi.mock("@/services/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api.js")>()),
  listSessionPlugins: vi.fn(),
}));
function fixture() {
  const dispatch = vi.fn();
  const deps: SseEventHandlerDeps = {
    dispatch,
    ds: {} as SseEventHandlerDeps["ds"],
    stateRef: { current: { ...initialState } },
    sessionIdRef: { current: "s" },
    deltaBufferRef: { current: new Map() },
    deltaRafRef: { current: null },
    lastBackfilledTurnIdRef: { current: null },
  };
  const handler = createSseEventHandler(deps);
  const send = (type: string) =>
    handler({
      type,
      payload: { pluginId: "p", reason: "runtime" },
      requestId: "r",
      traceId: "t",
      flowId: "t",
      seq: 0,
      sessionId: "s",
      turnId: "turn",
      timestamp: "2026-10-29T00:00:00Z",
    });
  return { deps, dispatch, send };
}
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  vi.mocked(api.listSessionPlugins).mockResolvedValue({
    items: [],
    commands: [],
    unavailable: [],
  });
});
describe("plugin fault notices", () => {
  it("toasts fixed text and refreshes for action events; counted is trace-only", async () => {
    const f = fixture();
    const toast = vi.fn();
    const unsubscribe = subscribeToast(toast);
    try {
      f.send("plugin.fault.counted");
      expect(toast).not.toHaveBeenCalled();
      f.send("plugin.fault.latched");
      await vi.waitFor(() =>
        expect(f.dispatch).toHaveBeenCalledWith(
          expect.objectContaining({ type: "LOAD_SESSION_PLUGINS" }),
        ),
      );
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "p is paused in this session after repeated errors.",
          kind: "info",
        }),
      );
      vi.mocked(api.listSessionPlugins).mockClear();
      f.send("plugin.fault.cleared");
      await vi.waitFor(() =>
        expect(api.listSessionPlugins).toHaveBeenCalledWith("s"),
      );
      expect(toast).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });
  it("handles background notices and dedupes the action/subscription overlap", async () => {
    const f = fixture();
    const toast = vi.fn();
    const unsubscribe = subscribeToast(toast);
    const background = createSubscriptionEventHandler({
      ...f.deps,
      isCurrent: () => true,
      getRecoveryGeneration: () => 0,
      onReset: vi.fn(),
      onBackgroundJobEnded: vi.fn(),
    });
    try {
      background({
        type: "plugin.fault.latched",
        sessionId: "s",
        timestamp: "2026-10-29T00:00:00Z",
        payload: { pluginId: "p", reason: "runtime", turnId: "turn" },
        topic: "plugin",
        id: "notice",
      });
      f.send("plugin.fault.latched");
      expect(toast).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });
});
