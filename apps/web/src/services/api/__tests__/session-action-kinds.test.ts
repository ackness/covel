// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import * as toastChannel from "@/lib/toast-channel.js";
import { getSessionActionKinds } from "../sessions.js";

describe("getSessionActionKinds", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fails without a toast, so the composer falls back to say quietly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: "not found" }),
        text: async () => "not found",
      }),
    );
    const emitToast = vi.spyOn(toastChannel, "emitToast");
    await expect(getSessionActionKinds("session-1")).rejects.toBeDefined();
    expect(emitToast).not.toHaveBeenCalled();
  });
});
