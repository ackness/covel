import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PluginSummary } from "@covel/shared";
import i18n from "@/i18n";
import { PluginListPanel } from "../plugin-list-panel.js";
import { isLockedCorePackage } from "../session-prep-screen.js";
import { worldStorageLabel } from "../world-select-screen.js";
import type { WorldRecord } from "@/services/api.js";

function plugin(
  id: string,
  trigger: "auto" | "manual" | "event",
  runtimeType: "agent" | "function" = "agent",
): PluginSummary {
  return {
    id,
    displayName: `${id[0]!.toUpperCase()}${id.slice(1)} Plugin`,
    description: `${id} plugin`,
    pluginType: "plugin",
    source: "builtin",
    status: "registered",
    runtimeCount: 1,
    capabilities: [],
    tags: [],
    runtimes: [
      {
        id,
        runtimeType,
        trigger: { type: trigger },
        execution: "sync",
        turnCompletion: { mode: "await" },
        outputKind: "plugin",
        capabilities: [],
        tags: [],
      },
    ],
    tools: [],
    userSettings: [],
  };
}

describe("session plugin metadata UI", () => {
  it("locks only builtin core plugins during session prep", () => {
    expect(
      isLockedCorePackage({ pluginType: "core-plugin", source: "builtin" }),
    ).toBe(true);
    expect(
      isLockedCorePackage({ pluginType: "core-plugin", source: "community" }),
    ).toBe(false);
    expect(
      isLockedCorePackage({ pluginType: "plugin", source: "builtin" }),
    ).toBe(false);
  });

  it("labels world storage locations", async () => {
    await i18n.changeLanguage("en-US");
    const base = {
      id: "world",
      name: "World",
      description: "Desc",
      createdAt: "2026-01-01T00:00:00.000Z",
    } satisfies WorldRecord;

    expect(
      worldStorageLabel({
        ...base,
        metadata: { storage: { scope: "browser", backend: "indexeddb" } },
      }),
    ).toBe("Browser IndexedDB");
    expect(
      worldStorageLabel({
        ...base,
        metadata: { storage: { scope: "server", backend: "pg" } },
      }),
    ).toBe("Server pg");
    expect(worldStorageLabel({ ...base, metadata: { source: "file" } })).toBe(
      "Built-in",
    );
  });

  it("renders runtime trigger labels from canonical trigger.type", async () => {
    await i18n.changeLanguage("en-US");
    render(
      <PluginListPanel
        plugins={[
          plugin("auto", "auto"),
          plugin("manual", "manual"),
          plugin("event", "event", "function"),
        ]}
      />,
    );

    fireEvent.click(screen.getByText("Auto Plugin"));
    fireEvent.click(screen.getByText("Manual Plugin"));
    fireEvent.click(screen.getByText("Event Plugin"));

    expect(screen.getByText("Automatic")).toBeTruthy();
    expect(screen.getByText("Manual")).toBeTruthy();
    expect(screen.getByText("Event")).toBeTruthy();
  });
});
