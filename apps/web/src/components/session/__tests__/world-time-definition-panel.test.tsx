import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PluginPanel } from "../plugin-panel.js";
import definitionSpec from "../../../../../../plugins/world-time/ui/definition-panel.json";
import {
  __clearAllPluginDataForTest,
  loadPluginData,
  setActiveSession,
} from "@/stores/plugin-data-store.js";

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: { gameState: { characters: [] }, session: { id: "before-story" } },
  }),
}));
vi.mock("react-force-graph-2d", () => ({ default: () => null }));
afterEach(() => {
  cleanup();
  __clearAllPluginDataForTest();
});

it("shows authored time rules before any clock has been committed", async () => {
  setActiveSession("before-story");
  loadPluginData("world-time", "definitions", [
    {
      key: "world",
      value: {
        id: "world",
        definition: {
          kind: "phases",
          name: "Tidal calendar",
          phases: ["High", "Low"],
          evolution: { prompt: "Wait for the tide to travel." },
        },
      },
    },
  ]);
  render(<PluginPanel pluginId="world-time" spec={definitionSpec} />);
  expect((await screen.findAllByText("Tidal calendar")).length).toBeGreaterThan(
    0,
  );
  expect(
    screen.getAllByText("Wait for the tide to travel.").length,
  ).toBeGreaterThan(0);
  expect(screen.queryByText("Time appears when the story starts.")).toBeNull();
});

it("explains the default calendar when no definition was imported", () => {
  setActiveSession("before-story");
  render(<PluginPanel pluginId="world-time" spec={definitionSpec} />);
  expect(screen.getByText(/12.*30/)).toBeTruthy();
});
