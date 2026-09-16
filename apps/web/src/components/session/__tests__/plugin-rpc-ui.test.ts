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
        pending: {
          pluginId: "server-plugin",
          action: "covel:plugin-server-code",
        },
      },
      sessionId: "session-1",
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
      "session-1",
    );
    expect(retry).toHaveBeenCalledTimes(1);
    expect(res).toBe(retryResponse);
  });

  it("resolves deferred server-code and action approvals in sequence", async () => {
    const actionApproval: PluginRpcResponse = {
      status: "approval-required",
      approvalId: "approval-action",
      pending: {
        pluginId: "server-plugin",
        action: "generate-image",
      },
    };
    const completed: PluginRpcResponse = { status: "ok", result: true };
    const retry = vi
      .fn<() => Promise<PluginRpcResponse>>()
      .mockResolvedValueOnce(actionApproval)
      .mockResolvedValueOnce(completed);
    const submitApproval = vi.fn(async () => undefined);
    const confirm = vi.fn(async () => true);

    const res = await resolvePluginRpcApprovalResponse({
      response: {
        status: "approval-required",
        approvalId: "approval-server-code",
        pending: {
          pluginId: "server-plugin",
          action: "covel:plugin-server-code",
        },
      },
      sessionId: "session-1",
      retry,
      pluginId: "server-plugin",
      actionLabel: "action generate-image",
      confirm,
      t,
      submitApproval,
    });

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        message: expect.stringContaining("covel:plugin-server-code"),
      }),
    );
    expect(confirm).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message: expect.stringContaining("generate-image"),
      }),
    );
    expect(submitApproval).toHaveBeenNthCalledWith(
      1,
      "approval-server-code",
      "allow",
      "session",
      "session-1",
    );
    expect(submitApproval).toHaveBeenNthCalledWith(
      2,
      "approval-action",
      "allow",
      "session",
      "session-1",
    );
    expect(retry).toHaveBeenCalledTimes(2);
    expect(res).toBe(completed);
  });

  it("stops when an already approved grant is requested again", async () => {
    const approval = (id: string): PluginRpcResponse => ({
      status: "approval-required",
      approvalId: id,
      pending: { pluginId: "server-plugin", action: "same-action" },
    });
    const retry = vi
      .fn<() => Promise<PluginRpcResponse>>()
      .mockResolvedValueOnce(approval("2"))
      .mockResolvedValueOnce(approval("3"));
    const submitApproval = vi.fn(async () => undefined);

    const res = await resolvePluginRpcApprovalResponse({
      response: approval("1"),
      sessionId: "session-1",
      retry,
      pluginId: "server-plugin",
      actionLabel: "action",
      confirm: async () => true,
      t,
      submitApproval,
    });

    expect(submitApproval).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(emitToast).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("approval-required"),
    );
    expect(res).toBeNull();
  });

  it("approves every provider in a multi-plugin form batch", async () => {
    const approval = (pluginId: string): PluginRpcResponse => ({
      status: "approval-required",
      approvalId: pluginId,
      pending: {
        sessionId: "session-1",
        pluginId,
        action: "covel:plugin-server-code",
      },
    });
    const completed: PluginRpcResponse = { status: "ok", result: true };
    const retry = vi
      .fn<() => Promise<PluginRpcResponse>>()
      .mockResolvedValueOnce(approval("two"))
      .mockResolvedValueOnce(approval("three"))
      .mockResolvedValueOnce(completed);
    const submitApproval = vi.fn(async () => undefined);
    const res = await resolvePluginRpcApprovalResponse({
      response: approval("one"),
      sessionId: "session-1",
      retry,
      pluginId: "framework",
      actionLabel: "submit-form",
      confirm: async () => true,
      t,
      submitApproval,
    });
    expect(submitApproval).toHaveBeenCalledTimes(3);
    expect(retry).toHaveBeenCalledTimes(3);
    expect(res).toBe(completed);
  });

  it("does not approve a response belonging to another session", async () => {
    const confirm = vi.fn(async () => true);
    const submitApproval = vi.fn(async () => undefined);
    const retry = vi.fn();
    expect(
      await resolvePluginRpcApprovalResponse({
        response: {
          status: "approval-required",
          approvalId: "foreign",
          pending: {
            sessionId: "other",
            pluginId: "provider",
            action: "covel:plugin-server-code",
          },
        },
        sessionId: "session-1",
        pluginId: "framework",
        actionLabel: "submit-form",
        confirm,
        submitApproval,
        retry,
        t,
      }),
    ).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(submitApproval).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });
});
