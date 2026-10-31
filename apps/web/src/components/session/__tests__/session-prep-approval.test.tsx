import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSummary, WorldPluginPlan } from "@covel/shared";
import i18n from "@/i18n/index.js";
import * as api from "@/services/api.js";
import {
  invalidateAllWorldRecords,
  primeWorldRecord,
} from "@/services/world-records.js";
import { SessionPrepScreen } from "../session-prep-screen.js";
import { usePrepRuntimeBindings } from "../session-prep/use-prep-runtime-bindings.js";

vi.mock("@/services/api.js", () => ({
  getWorldPluginPlan: vi.fn(),
  preflightWorldData: vi.fn(),
  getWorldOverlay: vi.fn(async () => null),
  fetchPluginFlows: vi.fn(async () => ({ steps: [] })),
}));
vi.mock("@/services/data-service.js", () => ({
  getDataService: () => ({
    listSessions: vi.fn(async () => []),
    prepareWorldForServer: vi.fn(async () => {}),
  }),
}));
vi.mock("@/hooks/use-slot-config.js", () => ({
  useSlotConfig: () => ({ resolvedSlots: [], refresh: vi.fn() }),
}));
vi.mock("../session-prep/use-prep-runtime-bindings.js", () => ({
  usePrepRuntimeBindings: vi.fn(() => ({ bindingState: { entries: [] } })),
}));
vi.mock("@/settings/SettingsDialog.js", () => ({ SettingsDialog: () => null }));
vi.mock("../session-prep/dimension-actions.js", () => ({
  DimensionActions: () => null,
}));
vi.mock("../session-prep/models-card.js", () => ({ ModelsCard: () => null }));

const world = {
  id: "community-world",
  name: "Community World",
  description: "",
  createdAt: "2026-10-15",
};
const plugins: PluginSummary[] = ["builtin", "community"].map((id) => ({
  id,
  displayName: id === "builtin" ? "Notes" : "Community Story",
  description: "",
  kind: "plugin",
  source: id === "builtin" ? "builtin" : "community",
  // Loading an entry for another session never grants this new one approval.
  hostState: "loaded",
  runtimeCount: 1,
  provides: [],
  requires: [],
  optional: [],
  conflicts: [],
  extensions: [],
  eventTopics: [],
  tags: [],
  runtimes: [
    {
      id,
      runtimeType: "function",
      trigger: { type: "auto" },
      execution: "sync",
      turnCompletion: { mode: "await" },
      outputKind: id === "community" ? "story" : "system",
      outputContract: undefined,
      tags: [],
    },
  ],
  tools: [],
  userSettings: [],
  languages: { text: ["en", "zh-CN"], instructions: ["en"] },
}));

beforeEach(() => {
  vi.clearAllMocks();
  invalidateAllWorldRecords();
  primeWorldRecord({ ...world, lore: "A world with a community receiver." });
  vi.mocked(api.getWorldPluginPlan).mockResolvedValue({
    worldId: world.id,
    packs: [],
    policy: {
      plus: ["community"],
      requires: [],
    },
    defaultPluginIds: ["builtin", "community"],
    missing: [],
  });
  vi.mocked(api.preflightWorldData).mockResolvedValue({
    imported: true,
    planned: 0,
    diagnostics: [],
    targets: [],
  });
});

describe("session prep approval preflight", () => {
  it("waits for plugin defaults before accepting edits and submits a core exclusion", async () => {
    await i18n.changeLanguage("en-US");
    let resolvePlan!: (plan: WorldPluginPlan) => void;
    const pendingPlan = new Promise<WorldPluginPlan>((resolve) => {
      resolvePlan = resolve;
    });
    vi.mocked(api.getWorldPluginPlan).mockReturnValueOnce(pendingPlan);
    const catalogue = plugins.map((plugin) => ({
      ...plugin,
      source: "builtin" as const,
      kind: plugin.id === "builtin" ? ("core" as const) : ("plugin" as const),
    }));
    const onStart = vi.fn();
    render(
      <SessionPrepScreen
        world={world}
        plugins={catalogue}
        presets={[]}
        onBack={vi.fn()}
        onStart={onStart}
        onResume={vi.fn()}
        onDeleteSession={vi.fn()}
        settingsOpen={false}
        onSettingsOpenChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Loaded Plugins/ }));
    const toggle = screen.getByRole("switch", { name: "Notes", hidden: true });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.matches(":disabled")).toBe(true);
    resolvePlan({
      worldId: world.id,
      packs: [],
      policy: { plus: [], requires: [] },
      defaultPluginIds: catalogue.map((plugin) => plugin.id),
      missing: [],
    });
    await waitFor(() => expect(toggle.matches(":disabled")).toBe(false));
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    const start = screen.getAllByRole("button", {
      name: "Start Game",
    })[0]!;
    await waitFor(() => expect(start).toHaveProperty("disabled", false));
    fireEvent.click(start);
    await waitFor(() =>
      expect(onStart).toHaveBeenCalledWith(
        ["community"],
        undefined,
        ["builtin"],
        "player",
      ),
    );
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
  it.each([
    {
      locale: "en-US",
      role: "host",
      title: "Needs approval",
      hint: "imported once",
      summary: "1/2 plugins enabled · 1 runtimes",
    },
    {
      locale: "zh-CN",
      role: "spectator",
      title: "需要批准",
      hint: "导入一次",
      summary: "已启用 1/2 个插件 · 共 1 个运行任务",
    },
  ])(
    "keeps pending requests separate and lets the game start ($locale, $role)",
    async ({ locale, role, title, hint, summary }) => {
      await i18n.changeLanguage(locale);
      const onStart = vi
        .fn()
        .mockRejectedValueOnce(new Error("Creation refused"));
      render(
        <SessionPrepScreen
          world={world}
          plugins={plugins}
          presets={[]}
          onBack={vi.fn()}
          onStart={onStart}
          onResume={vi.fn()}
          onDeleteSession={vi.fn()}
          settingsOpen={false}
          onSettingsOpenChange={vi.fn()}
        />,
      );

      expect(
        (screen.getByLabelText(i18n.t("session.playAs")) as HTMLSelectElement)
          .value,
      ).toBe("player");
      fireEvent.change(screen.getByLabelText(i18n.t("session.playAs")), {
        target: { value: role },
      });
      const pending = await screen.findByTestId("pending-approval-plugins");
      expect(pending.textContent).toContain(title);
      expect(pending.textContent).toContain("Community Story");
      expect(pending.textContent).toContain(hint);
      expect(pending.textContent).not.toContain("Notes");
      expect(screen.getByText(summary)).toBeTruthy();
      expect(screen.getByTestId("no-story-plugin").textContent).toContain(
        i18n.t("plugin.noStory.approvalRequired"),
      );
      expect(
        screen.queryByRole("button", {
          name: i18n.t("plugin.off.turnOn", { plugin: "Community Story" }),
        }),
      ).toBeNull();
      await waitFor(() =>
        expect(api.preflightWorldData).toHaveBeenLastCalledWith(world.id, {
          plugins: ["builtin"],
        }),
      );
      expect(
        vi
          .mocked(usePrepRuntimeBindings)
          .mock.lastCall?.[1].map((plugin) => plugin.id),
      ).toEqual(["builtin"]);

      fireEvent.click(
        screen.getByRole("button", {
          name: new RegExp(i18n.t("session.plugins")),
        }),
      );
      expect(
        screen
          .getByRole("switch", { name: "Community Story", hidden: true })
          .getAttribute("aria-checked"),
      ).toBe("true");
      const start = screen.getAllByRole("button", {
        name: i18n.t("session.startGame"),
      })[0];
      expect(start).toBeDefined();
      fireEvent.click(start!);
      await waitFor(() =>
        expect(onStart).toHaveBeenCalledWith(
          ["builtin", "community"],
          undefined,
          [],
          role,
        ),
      );
      expect(
        (screen.getByLabelText(i18n.t("session.playAs")) as HTMLSelectElement)
          .value,
      ).toBe(role);
    },
  );
});
