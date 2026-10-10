// @vitest-environment node
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
  it("posts the resolved payload through the shared approval flow", async () => {
    await invokeCatalogAction({
      sessionId: "s",
      action: {
        pluginId: "owner",
        runtimeId: "owner/generate",
        payload: { prompt: { from: "item.prompt" } },
      },
      scope: { item: { prompt: "a lighthouse" } },
      t: (key) => key,
    });
    const args = vi.mocked(postPluginRpcWithApproval).mock.calls.at(-1)![0];
    const request = args.request as () => Promise<unknown>;
    expect(await request()).toEqual({
      kind: "runtime",
      pluginId: "owner",
      runtimeId: "owner/generate",
      payload: { prompt: "a lighthouse" },
    });
  });
});
