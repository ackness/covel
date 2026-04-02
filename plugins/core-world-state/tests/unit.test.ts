import { describe, it, expect } from "vitest";
import {
  createMockToolContext,
  createMockProviderInput,
  createCollectingRegistrar,
  findProposal,
  findProposals,
} from "@covel/plugin-test-utils";
import register from "../server/index.js";
import { updateLocationTool, advanceTimeTool, setWeatherTool } from "../server/tools.js";
import { worldStateContextProvider } from "../server/context-provider.js";

// ── Registration ────────────────────────────────────────────────

describe("register", () => {
  it("registers tools and context provider", () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    expect(contributions.tools.has("update-location")).toBe(true);
    expect(contributions.tools.has("advance-time")).toBe(true);
    expect(contributions.tools.has("set-weather")).toBe(true);
    expect(contributions.contextProviders.has("world-state-context")).toBe(true);
    expect(contributions.runtimeHandlers.size).toBe(0);
  });
});

// ── update-location ─────────────────────────────────────────────

describe("updateLocationTool", () => {
  it("emits state.patch and event.emit for location change", async () => {
    const ctx = createMockToolContext({
      toolId: "update-location",
      pluginId: "core-world-state",
      input: { location: "回声森林", subLocation: "空地" },
    });

    const result = await updateLocationTool(ctx);

    expect(result.proposals).toHaveLength(2);

    const statePatch = findProposal<{ worldState: { location: unknown } }>(
      result.proposals ?? [],
      "state.patch"
    );
    expect(statePatch).toBeDefined();
    expect(statePatch?.worldState.location).toEqual({
      location: "回声森林",
      subLocation: "空地",
    });

    const event = findProposal<{ type: string; data: unknown }>(
      result.proposals ?? [],
      "event.emit"
    );
    expect(event).toBeDefined();
    expect(event?.type).toBe("location_changed");
  });

  it("works with location only (no subLocation)", async () => {
    const ctx = createMockToolContext({
      toolId: "update-location",
      pluginId: "core-world-state",
      input: { location: "Merchant District" },
      locale: "en-US",
    });

    const result = await updateLocationTool(ctx);

    const statePatch = findProposal<{ worldState: { location: unknown } }>(
      result.proposals ?? [],
      "state.patch"
    );
    expect(statePatch?.worldState.location).toEqual({
      location: "Merchant District",
    });
    expect(result.output).toHaveProperty("message");
  });

  it("returns error when location is missing", async () => {
    const ctx = createMockToolContext({
      toolId: "update-location",
      pluginId: "core-world-state",
      input: {},
    });

    const result = await updateLocationTool(ctx);

    expect(result.proposals).toHaveLength(0);
    expect(result.output).toHaveProperty("error");
  });
});

// ── advance-time ────────────────────────────────────────────────

describe("advanceTimeTool", () => {
  it("emits state.patch and event.emit for time advancement", async () => {
    const ctx = createMockToolContext({
      toolId: "advance-time",
      pluginId: "core-world-state",
      input: { period: "dusk", elapsed: "数小时" },
    });

    const result = await advanceTimeTool(ctx);

    expect(result.proposals).toHaveLength(2);

    const statePatch = findProposal<{ worldState: { time: unknown } }>(
      result.proposals ?? [],
      "state.patch"
    );
    expect(statePatch?.worldState.time).toEqual({
      period: "dusk",
      elapsed: "数小时",
    });

    const event = findProposal<{ type: string }>(
      result.proposals ?? [],
      "event.emit"
    );
    expect(event?.type).toBe("time_advanced");
  });

  it("accepts partial input (period only)", async () => {
    const ctx = createMockToolContext({
      toolId: "advance-time",
      pluginId: "core-world-state",
      input: { period: "morning" },
      locale: "en-US",
    });

    const result = await advanceTimeTool(ctx);

    const statePatch = findProposal<{ worldState: { time: Record<string, unknown> } }>(
      result.proposals ?? [],
      "state.patch"
    );
    expect(statePatch?.worldState.time.period).toBe("morning");
    expect(statePatch?.worldState.time.elapsed).toBeUndefined();
  });

  it("accepts partial input (elapsed only)", async () => {
    const ctx = createMockToolContext({
      toolId: "advance-time",
      pluginId: "core-world-state",
      input: { elapsed: "a few minutes" },
      locale: "en-US",
    });

    const result = await advanceTimeTool(ctx);

    const statePatch = findProposal<{ worldState: { time: Record<string, unknown> } }>(
      result.proposals ?? [],
      "state.patch"
    );
    expect(statePatch?.worldState.time.elapsed).toBe("a few minutes");
    expect(statePatch?.worldState.time.period).toBeUndefined();
  });

  it("returns error for invalid period", async () => {
    const ctx = createMockToolContext({
      toolId: "advance-time",
      pluginId: "core-world-state",
      input: { period: "brunch" },
    });

    const result = await advanceTimeTool(ctx);

    expect(result.proposals).toHaveLength(0);
    expect(result.output).toHaveProperty("error");
  });
});

// ── set-weather ─────────────────────────────────────────────────

describe("setWeatherTool", () => {
  it("emits state.patch for weather change", async () => {
    const ctx = createMockToolContext({
      toolId: "set-weather",
      pluginId: "core-world-state",
      input: { weather: "暴雨", severity: "severe" },
    });

    const result = await setWeatherTool(ctx);

    expect(result.proposals).toHaveLength(1);

    const statePatch = findProposal<{ worldState: { weather: unknown } }>(
      result.proposals ?? [],
      "state.patch"
    );
    expect(statePatch?.worldState.weather).toEqual({
      weather: "暴雨",
      severity: "severe",
    });
  });

  it("works with weather only (no severity)", async () => {
    const ctx = createMockToolContext({
      toolId: "set-weather",
      pluginId: "core-world-state",
      input: { weather: "clear" },
      locale: "en-US",
    });

    const result = await setWeatherTool(ctx);

    const statePatch = findProposal<{ worldState: { weather: Record<string, unknown> } }>(
      result.proposals ?? [],
      "state.patch"
    );
    expect(statePatch?.worldState.weather.weather).toBe("clear");
    expect(statePatch?.worldState.weather.severity).toBeUndefined();
  });

  it("returns error for invalid severity", async () => {
    const ctx = createMockToolContext({
      toolId: "set-weather",
      pluginId: "core-world-state",
      input: { weather: "rain", severity: "extreme" },
    });

    const result = await setWeatherTool(ctx);

    expect(result.proposals).toHaveLength(0);
    expect(result.output).toHaveProperty("error");
  });
});

// ── Context Provider ────────────────────────────────────────────

describe("worldStateContextProvider", () => {
  it("formats full world state in zh-CN", async () => {
    const input = createMockProviderInput({
      pluginId: "core-world-state",
      locale: "zh-CN",
      state: {
        worldState: {
          location: { location: "回声森林", subLocation: "空地" },
          time: { period: "dusk" },
          weather: { weather: "雨", severity: "moderate" },
        },
      },
    });

    const result = await worldStateContextProvider(input);

    expect(result.id).toBe("world-state-summary");
    expect(result.content).toContain("当前世界状态");
    expect(result.content).toContain("回声森林 - 空地");
    expect(result.content).toContain("黄昏");
    expect(result.content).toContain("雨");
    expect(result.content).toContain("中等");
  });

  it("formats full world state in en-US", async () => {
    const input = createMockProviderInput({
      pluginId: "core-world-state",
      locale: "en-US",
      state: {
        worldState: {
          location: { location: "Forest of Echoes" },
          time: { period: "morning" },
          weather: { weather: "clear", severity: "mild" },
        },
      },
    });

    const result = await worldStateContextProvider(input);

    expect(result.content).toContain("Current World State");
    expect(result.content).toContain("Forest of Echoes");
    expect(result.content).toContain("morning");
    expect(result.content).toContain("clear");
    expect(result.content).toContain("mild");
  });

  it("shows unknown for missing state fields", async () => {
    const input = createMockProviderInput({
      pluginId: "core-world-state",
      locale: "zh-CN",
      state: {},
    });

    const result = await worldStateContextProvider(input);

    expect(result.content).toContain("位置: 未知");
    expect(result.content).toContain("时间: 未知");
    expect(result.content).toContain("天气: 未知");
  });

  it("handles partial state gracefully", async () => {
    const input = createMockProviderInput({
      pluginId: "core-world-state",
      locale: "en-US",
      state: {
        worldState: {
          location: { location: "Tavern" },
        },
      },
    });

    const result = await worldStateContextProvider(input);

    expect(result.content).toContain("Tavern");
    expect(result.content).toContain("Time: unknown");
    expect(result.content).toContain("Weather: unknown");
  });
});
