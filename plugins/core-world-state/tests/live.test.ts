import { describe, it, expect } from "vitest";
import {
  LIVE,
  createLiveGenerateText,
  findProposal,
} from "@covel/plugin-test-utils";
import { updateLocationTool, advanceTimeTool, setWeatherTool } from "../server/tools.js";

/**
 * Live LLM integration tests.
 *
 * These tests verify that a real LLM (qwen3.5-flash via dashscope) can
 * produce valid tool call inputs for the world-state tools.
 *
 * Run with: LIVE_LLM_ENABLED=1 DASHSCOPE_API_KEY=<key> pnpm test
 */
describe.skipIf(!LIVE)("live: world-state tools with LLM", () => {
  it("LLM extracts location change and produces valid tool input", async () => {
    const generateText = await createLiveGenerateText();

    const narrative =
      "你沿着蜿蜒的小路走了许久，终于来到了一片开阔的山谷。远处可以看到一座古老的石桥横跨在湍急的河流之上。";

    const prompt = [
      "You are a world state tracker. Read the following narrative and extract location information.",
      "Respond with ONLY a JSON object in this format: { \"location\": \"<main location>\", \"subLocation\": \"<optional sub-location>\" }",
      "Do not add any explanation. Only output JSON.",
      "",
      `Narrative: ${narrative}`,
    ].join("\n");

    const response = await generateText(prompt);
    const parsed = JSON.parse(response.replace(/```json?\n?/g, "").replace(/```/g, "").trim());

    expect(parsed).toHaveProperty("location");
    expect(typeof parsed.location).toBe("string");
    expect(parsed.location.length).toBeGreaterThan(0);

    // Feed the LLM output into our tool
    const result = await updateLocationTool({
      toolId: "update-location",
      pluginId: "core-world-state",
      runtimeId: "world-state-tracker",
      locale: "zh-CN",
      input: parsed,
    });

    const statePatch = findProposal<{ worldState: { location: unknown } }>(
      result.proposals ?? [],
      "state.patch"
    );
    expect(statePatch).toBeDefined();
    expect(statePatch?.worldState.location).toHaveProperty("location");
  });

  it("LLM extracts time change from English narrative", async () => {
    const generateText = await createLiveGenerateText();

    const narrative =
      "Hours passed as they traveled through the dense forest. By the time they reached the clearing, the sun had begun to set, painting the sky in shades of orange and purple.";

    const prompt = [
      "You are a world state tracker. Read the following narrative and extract time information.",
      "Respond with ONLY a JSON object: { \"period\": \"<one of: dawn,morning,noon,afternoon,dusk,evening,night,midnight>\", \"elapsed\": \"<description of time passed>\" }",
      "Do not add any explanation. Only output JSON.",
      "",
      `Narrative: ${narrative}`,
    ].join("\n");

    const response = await generateText(prompt);
    const parsed = JSON.parse(response.replace(/```json?\n?/g, "").replace(/```/g, "").trim());

    expect(parsed).toHaveProperty("period");

    const result = await advanceTimeTool({
      toolId: "advance-time",
      pluginId: "core-world-state",
      runtimeId: "world-state-tracker",
      locale: "en-US",
      input: parsed,
    });

    const statePatch = findProposal<{ worldState: { time: Record<string, unknown> } }>(
      result.proposals ?? [],
      "state.patch"
    );
    expect(statePatch).toBeDefined();
    expect(statePatch?.worldState.time).toHaveProperty("period");
  });

  it("LLM extracts weather from narrative", async () => {
    const generateText = await createLiveGenerateText();

    const narrative =
      "突然间，天空变得阴沉，狂风呼啸而过。豆大的雨点开始猛烈地砸向地面，一场暴风雨正在来临。";

    const prompt = [
      "You are a world state tracker. Read the following narrative and extract weather information.",
      "Respond with ONLY a JSON object: { \"weather\": \"<weather condition>\", \"severity\": \"<one of: mild,moderate,severe>\" }",
      "Do not add any explanation. Only output JSON.",
      "",
      `Narrative: ${narrative}`,
    ].join("\n");

    const response = await generateText(prompt);
    const parsed = JSON.parse(response.replace(/```json?\n?/g, "").replace(/```/g, "").trim());

    expect(parsed).toHaveProperty("weather");

    const result = await setWeatherTool({
      toolId: "set-weather",
      pluginId: "core-world-state",
      runtimeId: "world-state-tracker",
      locale: "zh-CN",
      input: parsed,
    });

    const statePatch = findProposal<{ worldState: { weather: unknown } }>(
      result.proposals ?? [],
      "state.patch"
    );
    expect(statePatch).toBeDefined();
  });
});
