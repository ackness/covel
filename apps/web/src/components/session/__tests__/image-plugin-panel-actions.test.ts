import { describe, expect, it, vi } from "vitest";
import {
  invokeCatalogAction,
  resolveCatalogPayload,
} from "@/lib/catalog/catalog-actions.js";
import { postPluginRpcWithApproval } from "../plugin-rpc-ui.js";
vi.mock("../plugin-rpc-ui.js", () => ({
  postPluginRpcWithApproval: vi.fn(async () => null),
  emitPluginRpcRuntimeResponse: vi.fn(),
}));
describe("catalog actions", () => {
  it("maps explicit selectors and preserves literal payloads", () => {
    expect(
      resolveCatalogPayload(
        { prompt: { from: "item.prompt" }, count: 3, action: "generate" },
        { item: { prompt: "a lighthouse" } },
      ),
    ).toEqual({ prompt: "a lighthouse", count: 3, action: "generate" });
  });
  it("uses shared approval flow and lazily prepares upload only once", async () => {
    const prepare = vi.fn(async () => ({ upload: "media" }));
    await invokeCatalogAction({
      sessionId: "s",
      action: {
        pluginId: "owner",
        runtimeId: "owner/generate",
        payload: { ref: { from: "upload" } },
      },
      scope: {},
      prepare,
      t: (key) => key,
    });
    const args = vi.mocked(postPluginRpcWithApproval).mock.calls.at(-1)![0];
    expect(prepare).not.toHaveBeenCalled();
    const request = args.request as () => Promise<unknown>;
    expect(await request()).toMatchObject({
      pluginId: "owner",
      payload: { ref: "media" },
    });
    await request();
    expect(prepare).toHaveBeenCalledOnce();
  });
});
