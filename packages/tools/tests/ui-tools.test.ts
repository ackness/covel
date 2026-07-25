import { describe, expect, it } from "vitest";
import { normalizeUIRenderInstruction } from "@covel/shared";
import { createNotificationTool, renderUITool } from "../src/index.js";

const CTX = {
  sessionId: "sess-1",
  turnId: "turn-1",
  pluginId: "plugin",
  runtimeId: "runtime",
};

describe("builtin ui tools", () => {
  it("render-ui returns typed ui parts with independent status", async () => {
    const result = await renderUITool.execute(
      {
        layout: "stream",
        parts: [
          { id: "p1", type: "text", status: "streaming", content: "hello" },
          {
            id: "p2",
            type: "image",
            status: "pending",
            content: { prompt: "forest" },
          },
        ],
      },
      {
        sessionId: "sess-1",
        turnId: "turn-1",
        pluginId: "plugin",
        runtimeId: "runtime",
      },
    );

    expect(result).toEqual({
      rendered: true,
      ui: [
        {
          layout: "stream",
          parts: [
            { id: "p1", type: "text", status: "streaming", content: "hello" },
            {
              id: "p2",
              type: "image",
              status: "pending",
              content: { prompt: "forest" },
            },
          ],
        },
      ],
    });
  });

  it("create-notification emits a ui payload the runtime will promote", async () => {
    // Only a result carrying `ui` (or `interaction`) is picked up by
    // `findPresentableToolOutput`. Returning a bare `{ notified: true }` makes
    // the tool report success to the model while the player sees nothing.
    const result = (await createNotificationTool.execute(
      { level: "success", title: "获得物品", message: "你捡到了一把钥匙。" },
      CTX,
    )) as { notified: boolean; ui: unknown[] };

    expect(result.notified).toBe(true);
    expect(Array.isArray(result.ui)).toBe(true);
    expect(result.ui).toHaveLength(1);
  });

  it("create-notification survives normalization as a nested Alert spec", async () => {
    // The kernel runs every ui block through `normalizeUIRenderInstruction`
    // before committing it, and the renderer maps a part onto a component only
    // when the part's `content` is itself a spec. Assert across that boundary:
    // a part whose content is not a spec renders as raw JSON instead.
    const result = (await createNotificationTool.execute(
      { level: "warning", title: "警告", message: "水源已污染。" },
      CTX,
    )) as { ui: unknown[] };

    const normalized = normalizeUIRenderInstruction(
      result.ui[0] as Parameters<typeof normalizeUIRenderInstruction>[0],
    );

    expect(normalized.parts).toHaveLength(1);
    expect(normalized.parts[0]!.content).toEqual({
      type: "Alert",
      props: {
        level: "warning",
        title: "警告",
        message: "水源已污染。",
      },
    });
  });
});
