import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSummary } from "@covel/shared";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";
import i18n from "@/i18n";
import { PluginListPanel } from "../plugin-list-panel.js";
import { PluginPackageRow } from "../session-prep/plugin-package-row.js";

const plugin: PluginSummary = {
  id: "fixture",
  displayName: "Function fixture",
  description: "",
  kind: "plugin",
  source: "builtin",
  hostState: "loaded",
  runtimeCount: 1,
  requires: [],
  optional: [],
  conflicts: [],
  extensions: [],
  eventTopics: [],
  provides: [],
  tags: [],
  tools: [],
  userSettings: [],
  languages: { text: ["en"], instructions: ["en"] },
  runtimes: [
    {
      id: "fixture/function",
      runtimeType: "function",
      model: "fast",
      trigger: { type: "manual" },
      execution: "sync",
      turnCompletion: { mode: "await" },
      outputKind: "system",
      outputContract: undefined,
    },
  ],
};
const storySlot: ResolvedSlot = {
  slotId: "story",
  label: "story",
  tag: "text",
  presetId: "fixture-model",
  preset: {
    id: "fixture-model",
    name: "fixture-model",
    provider: "fixture-provider",
    model: "fixture-model",
    enabled: true,
    isDefault: true,
    scope: "global",
  },
};

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

describe.each(["session", "prep"] as const)(
  "%s function model display",
  (surface) => {
    function show(pkg = plugin, resolvedSlots = [storySlot]) {
      if (surface === "session") {
        const view = render(
          <PluginListPanel
            plugins={[pkg]}
            sessionPlugins={[
              {
                ...pkg,
                active: true,
                serverCodeApproved: true,
                sessionState: "active",
                locked: false,
              },
            ]}
            sessionId="fixture-session"
            runtimeModelOverrides={{ "fixture/function": "ignored-override" }}
            resolvedSlots={resolvedSlots}
          />,
        );
        fireEvent.click(
          screen.getByRole("checkbox", {
            name: "Customize plugins and advanced settings",
          }),
        );
        return view;
      }
      return render(
        <PluginPackageRow
          pkg={pkg}
          pluginPlan={null}
          activePluginPack={null}
          selectedPluginIdSet={new Set([pkg.id])}
          corePluginIds={new Set()}
          lockedPluginIds={new Set()}
          resolvedSlots={resolvedSlots}
          isMissingDeclaredSlot={() => false}
          onTogglePlugin={vi.fn()}
          bindingState={{
            entries: [],
            bindings: {},
            allBound: true,
            setBinding: vi.fn(),
            autoAssign: vi.fn(),
            compatibleSlots: () => resolvedSlots,
          }}
        />,
      );
    }

    it("shows the declared slot and fallback provider/model without an override control", () => {
      show();
      expect(screen.getByText("Runtime default: fast")).toBeTruthy();
      expect(
        screen.getByText(
          "fast is not set up; uses fixture-provider · fixture-model",
        ),
      ).toBeTruthy();
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByRole("combobox")).toBeNull();
    });

    it("shows the configured provider/model without a fallback warning or select", () => {
      show(plugin, [{ ...storySlot, slotId: "fast" }]);
      expect(screen.getByText("Runtime default: fast")).toBeTruthy();
      expect(screen.getByText("fixture-provider · fixture-model")).toBeTruthy();
      expect(screen.queryByText(/is not set up/)).toBeNull();
      expect(screen.queryByRole("combobox")).toBeNull();
    });

    it("reports an unavailable declared slot without falling back or offering a select", () => {
      show(plugin, [
        storySlot,
        { ...storySlot, slotId: "fast", isAvailable: false },
      ]);
      expect(screen.getByRole("status").textContent).toContain(
        "Model role fast is unavailable.",
      );
      expect(screen.queryByText(/is not set up/)).toBeNull();
      expect(screen.queryByRole("combobox")).toBeNull();
    });

    it("adds no model display for a function without a declared model", () => {
      const { container } = show({
        ...plugin,
        runtimes: plugin.runtimes.map((runtime) => ({
          ...runtime,
          model: undefined,
        })),
      });
      expect(container.textContent).not.toContain("Runtime default:");
      expect(container.textContent).not.toContain("fixture-provider");
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByRole("combobox")).toBeNull();
    });
  },
);
