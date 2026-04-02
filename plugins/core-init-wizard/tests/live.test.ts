import { describe, it, expect } from "vitest";
import {
  LIVE,
  createLiveGenerateText,
  createCollectingRegistrar,
  createMockHandlerContext,
  findProposal,
} from "@covel/plugin-test-utils";
import register from "../server/index.js";

describe.skipIf(!LIVE)("live: core-init-wizard", () => {
  it("generates a contextual narrative transition via LLM", async () => {
    const generateText = await createLiveGenerateText();

    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const handler = contributions.runtimeHandlers.get("init-wizard")!;

    const ctx = createMockHandlerContext({
      contextOverrides: { locale: "zh-CN" },
      generateTextImpl: generateText,
    });

    const ctxWithNarrative = {
      ...ctx,
      context: {
        ...ctx.context,
        previousOutputs: [
          {
            narrative:
              "浓雾从码头升起，盐渍味混合着柴油的气息弥漫在空气中。远处传来起重机的低吟，一艘锈迹斑斑的货轮正缓缓驶入港口。",
          },
        ],
      },
    };

    const result = await handler(ctxWithNarrative);

    expect(result.proposals).toHaveLength(2);
    expect(result.proposals[0]!.kind).toBe("narrative.append");
    expect(result.proposals[1]!.kind).toBe("ui.render");

    const narrativePayload = result.proposals[0]!.payload as { text: string };
    // LLM should generate a non-empty transition
    expect(narrativePayload.text.length).toBeGreaterThan(10);
    // Should not be the fallback text (LLM should generate something unique)
    expect(narrativePayload.text).not.toBe("在这一切开始之前——你叫什么名字？");

    // character_creation block should still be present
    const uiPayload = findProposal<{
      type: string;
      content: { fields: Array<{ id: string }> };
    }>(result.proposals, "ui.render");
    expect(uiPayload).toBeDefined();
    expect(uiPayload!.type).toBe("character_creation");
  }, 60_000);
});
