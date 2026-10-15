import { describe, expect, it } from "vitest";
import { createBootstrapPluginRpc } from "../../src/routes/api/bootstrap/plugin-rpc-wiring.js";
import { emptyRpcStore } from "../helpers/rpc-store.js";

describe("bootstrap plugin RPC locale skeleton", () => {
  async function debugMessage(locale: string): Promise<string> {
    const { rpcExecutor } = createBootstrapPluginRpc();
    const dispatched = await rpcExecutor.dispatch(
      { pluginId: "framework", action: "slash-debug", payload: {} },
      {
        sessionId: "sess-locale",
        store: emptyRpcStore(),
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

  it.each(["zh-SG", "zh-Hans-CN"])(
    "resolves compatible Simplified Chinese locales (%s)",
    async (locale) => {
      await expect(debugMessage(locale)).resolves.toContain(
        "调试上下文已就绪：0 个活跃 runtime，story model 为 默认。",
      );
    },
  );

  it.each(["en-GB", "ru-RU", "fr-FR"])(
    "falls back to English (%s)",
    async (locale) => {
      await expect(debugMessage(locale)).resolves.toContain(
        "Debug context ready: 0 active runtime(s), story model default.",
      );
    },
  );
});
