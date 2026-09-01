import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store";
import { createBootstrapPluginRpc } from "../../src/routes/api/bootstrap/plugin-rpc-wiring.js";

describe("bootstrap plugin RPC locale skeleton", () => {
  async function debugMessage(locale: string): Promise<string> {
    const { rpcExecutor } = createBootstrapPluginRpc();
    const dispatched = await rpcExecutor.dispatch(
      { pluginId: "framework", action: "slash-debug", payload: {} },
      {
        sessionId: "sess-locale",
        store: createMemoryStore(),
        locale,
      },
    );
    return (dispatched.result as { message: string }).message;
  }

  it("uses English for Traditional Chinese and Chinese for explicit aliases", async () => {
    await expect(debugMessage("zh-Hant-TW")).resolves.toContain(
      "Debug context ready",
    );
    await expect(debugMessage("zh-TW")).resolves.toContain(
      "Debug context ready",
    );
    await expect(debugMessage("zh-Hans")).resolves.toContain(
      "调试上下文已就绪",
    );
  });
});
