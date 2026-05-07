/**
 * {{pluginName}} 插件测试
 */

import { describe, it, expect, vi } from "vitest";
import { tool, z } from "@covel/tools";
import createExampleAction from "../tools/example.js";

const mockStore = {
  setPluginData: vi.fn().mockResolvedValue(undefined),
};

const toolInstance = createExampleAction({ tool, z, store: mockStore });

const ctx = {
  sessionId: "sess-test",
  turnId: "turn-1",
  pluginId: "{{pluginName}}",
  runtimeId: "{{pluginName}}",
};

describe("example-action tool", () => {
  it("应该记录事件并返回 key", async () => {
    const result = await toolInstance.execute(
      { subject: "勇者", description: "打开了宝箱" },
      ctx,
    );

    expect(result.recorded).toBe(true);
    expect(result.key).toBeDefined();
  });

  it("应该调用 store.setPluginData 写入数据", async () => {
    await toolInstance.execute(
      { subject: "守卫", description: "发现了入侵者" },
      ctx,
    );

    expect(mockStore.setPluginData).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: ctx.sessionId,
        pluginId: ctx.pluginId,
        namespace: "events",
      }),
    );
  });
});
