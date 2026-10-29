import { describe, expect, it } from "vitest";
import register from "../server/index.js";

/** The `character-sheets` segment provider the entry registers. */
function sheetProvider() {
  let handler;
  register({
    pluginId: "narrator",
    provideExtension: (_point, _id, definition) => {
      handler = definition.handler;
    },
    on: () => {},
  });
  return handler;
}

const character = (id, name, type) => ({
  id,
  sessionId: "s",
  name,
  type,
  version: 1,
  createdAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:00.000Z",
});

describe("narrator character sheets", () => {
  it("show the primary seat's current character and list the other player character", () => {
    const [segment] = sheetProvider()(
      {},
      {
        locale: "en",
        world: {
          characterSchema: null,
          characters: [
            character("ada", "Ada", "player"),
            character("lin", "Lin", "player"),
            character("guide", "Guide", "npc"),
          ],
          seats: [
            {
              id: "main",
              controller: "human",
              role: "player",
              characters: "auto",
              currentCharacterId: "lin",
            },
          ],
        },
      },
    );
    const [sheet, profiles] = segment.content.split("<character-profiles>");
    expect(sheet).toContain('"name": "Lin"');
    expect(sheet).not.toContain("Ada");
    expect(profiles).toContain("- Ada [player]");
    expect(profiles).toContain("- Guide [npc]");
  });
});
