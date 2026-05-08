import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRpcResponse } from "@covel/shared";
import {
  emitPluginRpcRuntimeResponse,
  getPluginRpcFailureMessage,
  resolvePluginRpcApprovalResponse,
} from "../plugin-rpc-ui.js";
import { emitToast } from "@/lib/toast-channel.js";

vi.mock("@/lib/toast-channel.js", () => ({
  emitToast: vi.fn(),
}));

const t = (key: string, options?: Record<string, unknown>): string => {
  let text = String(options?.defaultValue ?? key);
  for (const [name, value] of Object.entries(options ?? {})) {
    text = text.replaceAll(`{{${name}}}`, String(value));
  }
  return text;
};

describe("plugin-rpc-ui", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts runtime failures from ok responses", () => {
    expect(
      getPluginRpcFailureMessage({
        status: "ok",
        runtimeResults: [
          {
            runtimeId: "rt",
            pluginId: "plugin",
            status: "failed",
            durationMs: 5,
            error: "boom",
            output: {},
          },
        ],
      }),
    ).toBe("boom");
  });

  it("emits no-follower error when an expected background follower is absent", () => {
    emitPluginRpcRuntimeResponse({
      response: { status: "ok", runtimeResults: [] },
      t,
      runtimeId: "prompt-runtime",
      expectsBackgroundFollower: true,
    });

    expect(emitToast).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("prompt-runtime"),
    );
  });

  it("emits accepted job toast", () => {
    emitPluginRpcRuntimeResponse({
      response: {
        status: "accepted",
        jobId: "job-123",
        pending: true,
        turnId: "turn-1",
        runtimeId: "rt",
      },
      t,
      runtimeId: "rt",
    });

    expect(emitToast).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("job-123"),
    );
  });

  it("resolves approval and retries the original request", async () => {
    const retryResponse: PluginRpcResponse = { status: "ok", result: true };
    const retry = vi.fn(async () => retryResponse);
    const submitApproval = vi.fn(async () => undefined);

    const res = await resolvePluginRpcApprovalResponse({
      response: {
        status: "approval-required",
        approvalId: "approval-1",
      },
      retry,
      pluginId: "plugin",
      actionLabel: "runtime rt",
      confirm: async () => true,
      t,
      submitApproval,
    });

    expect(submitApproval).toHaveBeenCalledWith(
      "approval-1",
      "allow",
      "session",
    );
    expect(retry).toHaveBeenCalledTimes(1);
    expect(res).toBe(retryResponse);
  });
});
