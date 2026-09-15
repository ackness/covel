import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hideReloadOverlay,
  showReloadOverlay,
} from "@/components/reload-overlay.js";
import { reloadServerAndWait } from "../desktop-bridge.js";

vi.mock("@/components/reload-overlay.js", () => ({
  showReloadOverlay: vi.fn(),
  hideReloadOverlay: vi.fn(),
}));

const invoke = vi.fn();
const reload = vi.fn();
const replace = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", {
    covelIpc: { invoke },
    location: { href: "http://127.0.0.1:9479/session", reload, replace },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("desktop restart navigation ownership", () => {
  it("waits for main-process navigation without reloading the old port", async () => {
    let finishRestart!: (value: { ok: true; port: number }) => void;
    const restart = new Promise<{ ok: true; port: number }>((resolve) => {
      finishRestart = resolve;
    });
    invoke.mockReturnValueOnce(restart);
    const pending = reloadServerAndWait({ message: "Restarting fixture" });
    expect(showReloadOverlay).toHaveBeenCalledWith("Restarting fixture");
    expect(invoke).toHaveBeenCalledWith("covel:restart-server");
    expect(reload).not.toHaveBeenCalled();

    finishRestart({ ok: true, port: 5258 });
    await expect(pending).resolves.toBe(true);
    expect(reload).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(hideReloadOverlay).not.toHaveBeenCalled();
  });

  it.each(["result", "rejection"])(
    "clears the overlay after an IPC %s failure",
    async (kind) => {
      if (kind === "result") {
        invoke.mockResolvedValueOnce({
          ok: false,
          port: 5258,
          error: "Restart failed",
        });
      } else {
        invoke.mockRejectedValueOnce(new Error("Restart failed"));
      }
      await expect(reloadServerAndWait()).rejects.toThrow("Restart failed");
      expect(hideReloadOverlay).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
    },
  );

  it("returns false outside Electron", async () => {
    delete window.covelIpc;
    await expect(reloadServerAndWait()).resolves.toBe(false);
    expect(showReloadOverlay).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
