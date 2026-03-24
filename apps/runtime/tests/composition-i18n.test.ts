import { describe, expect, it } from "vitest";

import { createRuntimeComposition } from "../src/composition.js";

describe("createRuntimeComposition i18n", () => {
  it("defaults guide command content and blocks to Chinese", async () => {
    const runtime = await createRuntimeComposition({
      cwd: process.cwd(),
      env: {}
    });

    const result = await runtime.commandBus.dispatch("/guide", {
      locale: "zh-CN",
      sessionId: "session_01"
    }) as {
      content: string;
      blocks: Array<{
        data: {
          title: string;
          options: Array<{ label: string }>;
        };
      }>;
    };

    expect(result.content).toContain("引导扩展已为");
    expect(result.blocks[0]?.data.title).toContain("下一步");
    expect(result.blocks[0]?.data.options.map((option) => option.label)).toEqual([
      "继续前进",
      "观察周围"
    ]);
  });

  it("renders guide command content and blocks in English when requested", async () => {
    const runtime = await createRuntimeComposition({
      cwd: process.cwd(),
      env: {}
    });

    const result = await runtime.commandBus.dispatch("/guide ruins", {
      locale: "en",
      sessionId: "session_01"
    }) as {
      content: string;
      blocks: Array<{
        data: {
          title: string;
          options: Array<{ label: string }>;
        };
      }>;
    };

    expect(result.content).toContain("Guide package prepared options for ruins.");
    expect(result.blocks[0]?.data.title).toBe("Next move for ruins");
    expect(result.blocks[0]?.data.options.map((option) => option.label)).toEqual([
      "Advance",
      "Observe"
    ]);
  });
});
