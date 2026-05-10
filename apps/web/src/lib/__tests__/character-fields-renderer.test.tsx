import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { JSONUIProvider } from "@json-render/react";
import { covelRegistry } from "../catalog.js";
import {
  __clearAllPluginDataForTest,
  loadPluginData,
  setActiveSession,
} from "../../stores/plugin-data-store.js";

afterEach(() => {
  cleanup();
  __clearAllPluginDataForTest();
});

function renderCharacterFields(value: unknown) {
  const CharacterFieldsView = covelRegistry.CharacterFieldsView;
  return render(
    <JSONUIProvider registry={covelRegistry}>
      <CharacterFieldsView
        element={{ type: "CharacterFieldsView", props: { value } }}
        emit={() => {}}
        on={() => ({
          emit: () => {},
          shouldPreventDefault: false,
          bound: false,
        })}
      />
    </JSONUIProvider>,
  );
}

function loadCharacterAttributeSchema() {
  setActiveSession("session-character-fields");
  loadPluginData("fixture-provider", "schema", [
    {
      key: "character-attributes",
      value: {
        attributes: [
          {
            id: "name",
            name: "Display Name",
            type: "string",
            category: "bio",
          },
          {
            id: "hp",
            name: "HP",
            type: "number",
            min: 0,
            max: 20,
            category: "stats",
          },
          {
            id: "mood",
            name: "Mood",
            type: "enum",
            category: "social",
          },
          {
            id: "traits",
            name: "Traits",
            type: "array",
            category: "abilities",
          },
          {
            id: "profile",
            name: "Profile",
            type: "object",
            category: "bio",
            subSchema: [
              {
                id: "age",
                name: "Age",
                type: "number",
                category: "bio",
              },
            ],
          },
          {
            id: "inventory",
            name: "Inventory",
            type: "map",
            category: "equipment",
          },
          {
            id: "courage",
            name: "Courage",
            type: "number",
            defaultValue: 3,
            category: "stats",
          },
        ],
      },
    },
  ]);
}

describe("CharacterFieldsView", () => {
  it("renders schema-known fields by category and falls back for unknown keys", () => {
    loadCharacterAttributeSchema();

    renderCharacterFields({
      name: "Mira",
      hp: 14,
      mood: "focused",
      traits: ["quick", "kind"],
      profile: { age: 19, nickname: "M" },
      inventory: { potion: 2 },
      inventedNote: { source: "runtime" },
    });

    expect(screen.getByText("Display Name")).toBeDefined();
    expect(screen.getByText("Mira")).toBeDefined();
    expect(screen.getByText("HP")).toBeDefined();
    expect(screen.getByText("14/20")).toBeDefined();
    expect(screen.getByText("Courage")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText("Mood")).toBeDefined();
    expect(screen.getByText("focused")).toBeDefined();
    expect(screen.getByText("Traits")).toBeDefined();
    expect(screen.getByText("quick")).toBeDefined();
    expect(screen.getByText("kind")).toBeDefined();
    expect(screen.getByText("Profile")).toBeDefined();
    expect(screen.getByText("Age")).toBeDefined();
    expect(screen.getByText("nickname")).toBeDefined();
    expect(screen.getByText("Inventory")).toBeDefined();
    expect(screen.getByText("potion")).toBeDefined();
    expect(screen.getByText("inventedNote")).toBeDefined();
    expect(screen.getByText("source")).toBeDefined();
    expect(screen.getByText("runtime")).toBeDefined();
  });

  it("discovers schema data from any provider plugin", () => {
    loadCharacterAttributeSchema();

    renderCharacterFields({ name: "Nia" });

    expect(screen.getByText("Display Name")).toBeDefined();
    expect(screen.getByText("Nia")).toBeDefined();
  });

  it("falls back to JSON rendering when no schema or object fields are present", () => {
    renderCharacterFields("unstructured field text");

    expect(screen.getByText("unstructured field text")).toBeDefined();
  });
});
