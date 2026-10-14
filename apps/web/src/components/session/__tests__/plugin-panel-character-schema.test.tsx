import spec from "../../../../../../plugins/world-init/runtimes/schema-gen/ui/world-schema.json";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/index.js";
import { PluginPanel } from "../plugin-panel.js";
import { initialState, reducer } from "@/stores/session-store/reducer.js";
import { enrichGameStateFromSnapshot } from "@/stores/session-store/game-state.js";

const session = vi.hoisted(() => ({
  gameState: {} as Record<string, unknown>,
}));
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: { gameState: session.gameState, session: { id: "session-a" } },
  }),
}));
const schema = {
  types: ["player"],
  attributes: [
    {
      id: "courage",
      name: "Courage",
      type: "number",
      category: "trait",
      description: "Facing the unknown",
    },
  ],
};
beforeEach(async () => {
  session.gameState = {};
  await i18n.changeLanguage("en-US");
});
afterEach(cleanup);

it("renders the bundled schema spec from a session snapshot for any plugin", () => {
  session.gameState = enrichGameStateFromSnapshot({
    characters: [],
    characterSchema: schema,
  });
  render(<PluginPanel pluginId="third-party-schema-viewer" spec={spec} />);
  expect(screen.getByText("Courage")).toBeTruthy();
  expect(screen.getByText("Facing the unknown")).toBeTruthy();
  expect(screen.queryByText(/not ready yet/)).toBeNull();
});

it("refreshes the same panel after a character-schema commit and clears on a missing schema", () => {
  const panel = render(
    <PluginPanel pluginId="third-party-schema-viewer" spec={spec} />,
  );
  expect(screen.getByText(/Character traits are not ready yet/)).toBeTruthy();
  const state = reducer(initialState, { type: "SET_CHARACTER_SCHEMA", schema });
  session.gameState = state.gameState;
  panel.rerender(
    <PluginPanel pluginId="third-party-schema-viewer" spec={spec} />,
  );
  expect(screen.getByText("Courage")).toBeTruthy();
  session.gameState = enrichGameStateFromSnapshot({
    characters: [],
    characterSchema: null,
  });
  panel.rerender(
    <PluginPanel pluginId="third-party-schema-viewer" spec={spec} />,
  );
  expect(screen.queryByText("Courage")).toBeNull();
  expect(screen.getByText(/Character traits are not ready yet/)).toBeTruthy();
});
