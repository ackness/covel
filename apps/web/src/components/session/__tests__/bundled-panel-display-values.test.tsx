import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/index.js";
import { PluginPanel } from "../plugin-panel.js";
import checksSpec from "../../../../../../plugins/dice-check/runtimes/recorder/ui/checks-panel.json";
import memorySpec from "../../../../../../plugins/memory/ui/memory-panel.json";
import characterSpec from "../../../../../../plugins/char-creator/ui/character-panel.json";
import {
  __clearAllPluginDataForTest,
  loadPluginDataForSession,
  setActiveSession,
} from "@/stores/plugin-data-store.js";

const session = vi.hoisted(() => ({
  characters: [] as unknown[],
}));
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: {
      gameState: { characters: session.characters },
      session: { id: "display-values" },
      pendingInteractionDrafts: [],
    },
  }),
}));
vi.mock("react-force-graph-2d", () => ({ default: () => null }));

const TURN_ID = "8f0c2a4e-5b1d-4c3e-9a7f-2d6b8e1c4a90";

beforeEach(async () => {
  session.characters = [];
  setActiveSession("display-values");
  await i18n.changeLanguage("zh-CN");
});
afterEach(async () => {
  cleanup();
  __clearAllPluginDataForTest();
  await i18n.changeLanguage("en-US");
});

it("names a dice check's turn by number and its attribute by the world's name", async () => {
  loadPluginDataForSession("display-values", "dice-check", "checks", [
    {
      key: `${TURN_ID}-1`,
      value: {
        action: "撬开地窖的铜锁",
        attribute: "agility",
        attributeLabel: "敏捷",
        outcomeLabel: { en: "Success", zh: "成功" },
        outcomeColor: "green",
        rollText: "14 + 3 = 17 vs DC 12",
        turnId: TURN_ID,
        turn: 7,
        turnLabel: { en: "Turn 7", zh: "第 7 回合" },
        seq: 1,
      },
    },
  ]);
  render(<PluginPanel pluginId="dice-check" spec={checksSpec} />);
  expect(await screen.findByText("第 7 回合")).toBeTruthy();
  expect(screen.getByText("敏捷")).toBeTruthy();
  expect(screen.queryByText("agility")).toBeNull();
  expect(screen.queryByText(TURN_ID)).toBeNull();
});

it("shows when a memory block changed as a short date, not an ISO timestamp", async () => {
  const updatedAt = "2026-10-28T09:15:00.000Z";
  loadPluginDataForSession("display-values", "memory", "blocks", [
    {
      key: "scene",
      value: {
        displayName: "Current scene",
        content: "At the harbour",
        charCount: 14,
        updatedAt,
      },
    },
  ]);
  render(<PluginPanel pluginId="memory" spec={memorySpec} />);
  expect(await screen.findByText("At the harbour")).toBeTruthy();
  expect(screen.queryByText(updatedAt)).toBeNull();
  const expected = new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(updatedAt));
  expect(screen.getByText(expected)).toBeTruthy();
});

it("labels the framework's character types and keeps a world's own type", async () => {
  session.characters = [
    { id: "c1", name: "Mira", type: "npc" },
    { id: "c2", name: "Bo", type: "companion" },
    { id: "c3", name: "Rook", type: "宿敌" },
  ];
  render(<PluginPanel pluginId="char-creator" spec={characterSpec} />);
  expect(await screen.findByText("Mira")).toBeTruthy();
  expect(screen.getByText("NPC")).toBeTruthy();
  expect(screen.getByText("Companion")).toBeTruthy();
  expect(screen.getByText("宿敌")).toBeTruthy();
  expect(screen.queryByText("npc")).toBeNull();
  expect(screen.queryByText("companion")).toBeNull();
});
