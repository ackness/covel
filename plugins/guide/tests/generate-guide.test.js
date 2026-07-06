import { describe, it, expect } from "vitest";
import { getPendingProposals, tool, z } from "@covel/tools";
import createGenerateGuide from "../tools/generate-guide.js";

const CONTEXT = {
  sessionId: "sess-1",
  pluginId: "guide",
  runtimeId: "guide",
  turnId: "turn-1",
};

describe("generate-guide tool", () => {
  const guideTool = createGenerateGuide({ tool, z });

  it("returns resolved categories with bilingual fallback labels", async () => {
    const result = await guideTool.execute(
      {
        topic: "How to enter the harbor",
        categories: [
          { style: "safe", suggestions: ["Ask the guard"] },
          { style: "wild", label: "全力一搏", suggestions: ["Jump the fence"] },
        ],
      },
      CONTEXT,
    );

    expect(result.topic).toBe("How to enter the harbor");
    expect(result.categories).toHaveLength(2);
    // No LLM label → bilingual I18nText from STYLE_CONFIG.
    expect(result.categories[0].label).toEqual({ zh: "稳妥", en: "Safe" });
    // LLM-supplied label passes through untouched.
    expect(result.categories[1].label).toBe("全力一搏");
    expect(result.categories[0].slot).toBe(1);
    expect(result.categories[1].slot).toBe(2);
  });

  it("emits one plugin.data.batch proposal covering the full message block", async () => {
    const result = await guideTool.execute(
      {
        topic: "Decision point",
        categories: [
          { style: "safe", suggestions: ["a", "b"] },
          { style: "creative", suggestions: ["c"] },
        ],
      },
      CONTEXT,
    );

    const proposals = getPendingProposals(result);
    expect(proposals).toHaveLength(1);
    const [proposal] = proposals;
    expect(proposal.type).toBe("plugin.data.batch");
    expect(proposal.sessionId).toBe("sess-1");
    expect(proposal.turnId).toBe("turn-1");
    expect(proposal.source).toEqual({ pluginId: "guide", runtimeId: "guide" });

    const items = proposal.payload.items;
    // 2 header keys + 2 categories × (3 meta + 3 suggestion slots).
    expect(items).toHaveLength(2 + 2 * 6);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(["key", "namespace", "value"]);
      expect(item.namespace).toBe("message");
    }

    const byKey = new Map(items.map((item) => [item.key, item.value]));
    expect(byKey.get("__turnId")).toBe("turn-1");
    expect(byKey.get("topic")).toBe("Decision point");
    expect(byKey.get("category1Suggestion1")).toBe("a");
    expect(byKey.get("category1Suggestion2")).toBe("b");
    // Unused suggestion slots are written as empty strings, not omitted.
    expect(byKey.get("category1Suggestion3")).toBe("");
    expect(byKey.get("category2Suggestion1")).toBe("c");
  });
});
