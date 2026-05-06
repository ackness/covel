import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { PluginListPanel } from "../plugin-list-panel.js";
import { defaultSelectedPluginIdsForWorld, isLockedCorePackage } from "../session-prep-screen.js";
import type { PackageSummary, WorldRecord } from "@/services/api.js";

describe("session plugin metadata UI", () => {
  it("locks builtin core-plugin packages during session prep", () => {
    expect(isLockedCorePackage({ pluginType: "core-plugin", source: "builtin" })).toBe(true);
    expect(isLockedCorePackage({ pluginType: "core-plugin", source: "community" })).toBe(false);
    expect(isLockedCorePackage({ pluginType: "plugin", source: "builtin" })).toBe(false);
  });

  it("uses world plugin metadata to compute session prep defaults", () => {
    const packages: PackageSummary[] = [
      { name: "pregame", pluginType: "core-plugin", source: "builtin", enabled: true, runtimes: [], tools: [] },
      { name: "narrator", pluginType: "core-plugin", source: "builtin", enabled: true, runtimes: [], tools: [] },
      { name: "chat-mode-narrator", pluginType: "plugin", source: "builtin", enabled: true, runtimes: [], tools: [] },
      { name: "scene-cast", pluginType: "plugin", source: "builtin", enabled: true, runtimes: [], tools: [] },
      { name: "guide", pluginType: "plugin", source: "builtin", enabled: true, runtimes: [], tools: [] },
    ];
    const world: WorldRecord = {
      id: "test-world",
      name: "Test World",
      description: "Test",
      metadata: {
        requiredPlugins: ["pregame"],
        recommendedPlugins: ["chat-mode-narrator", "scene-cast"],
        excludedPlugins: ["narrator", "guide"],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const selected = defaultSelectedPluginIdsForWorld(world, packages);

    expect(selected.has("pregame")).toBe(true);
    expect(selected.has("chat-mode-narrator")).toBe(true);
    expect(selected.has("scene-cast")).toBe(true);
    expect(selected.has("narrator")).toBe(false);
    expect(selected.has("guide")).toBe(false);
  });

  it("renders runtime trigger labels from trigger.mode", async () => {
    await i18n.changeLanguage("en-US");
    const packages: PackageSummary[] = [
      {
        name: "auto-plugin",
        displayName: "Auto Plugin",
        enabled: true,
        runtimes: [{ id: "auto-plugin", kind: "agent", priority: 100, trigger: { mode: "auto" } }],
      },
      {
        name: "manual-plugin",
        displayName: "Manual Plugin",
        enabled: true,
        runtimes: [{ id: "manual-plugin", kind: "agent", priority: 200, trigger: { mode: "manual" } }],
      },
      {
        name: "event-plugin",
        displayName: "Event Plugin",
        enabled: true,
        runtimes: [{ id: "event-plugin", kind: "function", priority: 300, trigger: { mode: "event" } }],
      },
    ];

    render(<PluginListPanel packages={packages} />);

    fireEvent.click(screen.getByText("Auto Plugin"));
    fireEvent.click(screen.getByText("Manual Plugin"));
    fireEvent.click(screen.getByText("Event Plugin"));

    expect(screen.getByText("Every turn")).toBeTruthy();
    expect(screen.getByText("Manual")).toBeTruthy();
    expect(screen.getByText("Event")).toBeTruthy();
  });
});
