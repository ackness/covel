import { beforeEach, describe, expect, it, vi } from "vitest";
import { postPluginRpcWithApproval } from "../plugin-rpc-ui.js";
import { rerunImagePrompt } from "../image-plugin-panels/actions.js";

vi.mock("../plugin-rpc-ui.js", () => ({
  postPluginRpcWithApproval: vi.fn(),
}));

describe("image plugin panel actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the bounded shared approval flow when rerunning an image", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(postPluginRpcWithApproval).mockImplementation(async (params) => {
      const approved = await params.confirm({
        title: "Authorize",
        message: "Authorize the second stage",
        confirmLabel: "Allow",
        cancelLabel: "Deny",
      });
      expect(approved).toBe(true);
      return null;
    });

    rerunImagePrompt({
      sessionId: "session-1",
      pluginId: "image-plugin",
      runtimeId: "image-plugin/generate",
      payload: { prompt: "a lighthouse" },
    });

    await vi.waitFor(() =>
      expect(postPluginRpcWithApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-1",
          pluginId: "image-plugin",
          actionLabel: "runtime image-plugin/generate",
          request: {
            pluginId: "image-plugin",
            runtimeId: "image-plugin/generate",
            payload: { prompt: "a lighthouse" },
          },
        }),
      ),
    );
    expect(confirm).toHaveBeenCalledWith("Authorize the second stage");
  });
});
