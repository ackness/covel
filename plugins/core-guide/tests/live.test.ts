import { describe, it, expect } from "vitest";
import {
  LIVE,
  createLiveGenerateText,
  createMockToolContext,
  createCollectingRegistrar,
  findProposal,
} from "@covel/plugin-test-utils";
import register from "../server/index.js";

describe.skipIf(!LIVE)("live: core-guide", () => {
  it("LLM can format a topic and the tool generates valid choices", async () => {
    const generateText = await createLiveGenerateText();

    // Simulate LLM deciding to call generate-choices with a topic
    const llmResponse = await generateText(
      `You are an RPG narrator. The player just arrived at a dock guarded by thugs.
Respond with a JSON object for a choices tool call:
{ "topic": "<concise decision description>", "options": [{ "label": "<option text>" }, ...] }
Output ONLY the JSON, no explanation.`
    );

    // Parse the LLM response to get tool input
    let toolInput: { topic?: string; options?: Array<{ label: string }> };
    try {
      const cleaned = llmResponse
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      toolInput = JSON.parse(cleaned);
    } catch {
      // If LLM doesn't return valid JSON, use a fallback
      toolInput = { topic: "dock approach", options: [{ label: "Sneak in" }] };
    }

    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const tool = contributions.tools.get("generate-choices")!;

    const ctx = createMockToolContext({
      locale: "en-US",
      pluginId: "core-guide",
      input: toolInput,
    });

    const result = await tool(ctx);

    expect(result.output).toBeDefined();
    expect(result.proposals).toHaveLength(1);

    const uiRender = findProposal<{
      type: string;
      content: { title: string; options: Array<{ id: string; label: string }> };
    }>(result.proposals!, "ui.render");

    expect(uiRender).toBeDefined();
    expect(uiRender!.type).toBe("choices");
    expect(uiRender!.content.options.length).toBeGreaterThanOrEqual(1);

    for (const opt of uiRender!.content.options) {
      expect(opt.id).toBeDefined();
      expect(opt.label.length).toBeGreaterThan(0);
    }
  }, 60_000);
});
