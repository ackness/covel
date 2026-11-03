import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PluginSummary } from "@covel/shared";
import i18n from "@/i18n";
import { PluginListPanel } from "../plugin-list-panel.js";
import { isDefaultPackage } from "../session-prep-screen.js";
import { worldStorageLabel } from "../world-select-screen.js";
import type { WorldRecord } from "@/services/api.js";

function plugin(
  id: string,
  trigger: "auto" | "manual" | "event",
  runtimeType: "agent" | "function" = "agent",
): PluginSummary {
  return {
    requires: [],
    optional: [],
    conflicts: [],
    extensions: [],
    eventTopics: [],
    id,
    displayName: `${id[0]!.toUpperCase()}${id.slice(1)} Plugin`,
    description: `${id} plugin`,
    kind: "plugin",
    source: "builtin",
    executionMode: "code" as const,
    hostState: "loaded",
    runtimeCount: 1,
    provides: [],
    tags: [],
    runtimes: [
      {
        id,
        runtimeType,
        trigger: { type: trigger },
        execution: "sync",
        turnCompletion: { mode: "await" },
        outputKind: "system",
        outputContract: undefined,
      },
    ],
    tools: [],
    userSettings: [],
    languages: { text: ["en"], instructions: ["en"] },
  };
}

describe("session plugin metadata UI", () => {
  it.each([false, true])(
    "shows load warnings with advanced settings closed (session=%s)",
    async (session) => {
      await i18n.changeLanguage("en-US");
      const partial: PluginSummary = {
        ...plugin("partial", "auto"),
        disabledRuntimes: [
          {
            sourcePath: "runtimes/notes/RUNTIME.md",
            message: "runtimes/notes/RUNTIME.md: schedule.stage: required",
          },
        ],
        ignoredFields: [
          {
            sourcePath: "PLUGIN.md",
            field: "futureFeature",
            message: "PLUGIN.md: futureFeature: unknown field",
          },
        ],
      };
      const view = render(
        <PluginListPanel
          plugins={[partial]}
          sessionPlugins={
            session
              ? [
                  {
                    ...partial,
                    active: true,
                    locked: false,
                    serverCodeApproved: true,
                    sessionState: "active",
                  },
                ]
              : undefined
          }
        />,
      );
      const warnings = screen.getByRole("list", {
        name: "Plugin load warnings",
      });
      expect(within(warnings).getAllByRole("listitem")).toHaveLength(2);
      expect(
        within(warnings).getByText(/Some features are unavailable/).textContent,
      ).toContain("runtimes/notes/RUNTIME.md");
      expect(
        within(warnings).getByText(/Unrecognized field futureFeature/),
      ).toBeTruthy();
      const details = within(warnings).getAllByText("Show reason")[0]!;
      fireEvent.click(details);
      expect(details.closest("details")?.open).toBe(true);
      expect(
        within(warnings).getByText(partial.disabledRuntimes![0]!.message),
      ).toBeTruthy();
      view.rerender(<PluginListPanel plugins={[plugin("healthy", "auto")]} />);
      expect(
        screen.queryByRole("list", { name: "Plugin load warnings" }),
      ).toBeNull();
    },
  );

  it("seeds every authorized core package before the session plan loads", () => {
    expect(
      isDefaultPackage({
        kind: "core",
        source: "builtin",
        executionMode: "code",
      }),
    ).toBe(true);
    // A community core package starts selected whenever the player could add
    // it without a new approval, exactly as the server resolver treats it.
    expect(
      isDefaultPackage({
        kind: "core",
        source: "community",
        executionMode: "declarative",
      }),
    ).toBe(true);
    expect(
      isDefaultPackage({
        kind: "core",
        source: "community",
        executionMode: "code",
        trust: {
          source: null,
          trustedSource: true,
          integrity: "verified",
          autoApproved: true,
        },
      }),
    ).toBe(true);
    expect(
      isDefaultPackage({
        kind: "core",
        source: "community",
        executionMode: "code",
      }),
    ).toBe(false);
    expect(
      isDefaultPackage({
        kind: "plugin",
        source: "builtin",
        executionMode: "code",
      }),
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

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Customize plugins and advanced settings",
      }),
    );
    fireEvent.click(screen.getByText("Auto Plugin"));
    fireEvent.click(screen.getByText("Manual Plugin"));
    fireEvent.click(screen.getByText("Event Plugin"));

    expect(screen.getByText("Automatic")).toBeTruthy();
    expect(screen.getByText("Manual")).toBeTruthy();
    expect(screen.getByText("Event")).toBeTruthy();
  });
});
