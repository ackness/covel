import { expect, it } from "vitest";
import { createSearchablePluginDataResolver } from "../../src/routes/api/bootstrap/searchable-plugin-data.js";

const plugin = (
  id: string,
  data: Record<string, unknown>,
  status = "loaded",
  requires: string[] = [],
) =>
  ({
    id,
    status,
    packageManifest: {
      manifest: {},
      plugin: { requires, contributes: { data } },
    },
  }) as never;

it("lists the searchable namespaces of the plugins active in the session only", async () => {
  const resolve = createSearchablePluginDataResolver({
    store: {
      getSession: async (id) =>
        id === "session"
          ? ({ activePlugins: ["journal", "broken", "dependent"] } as never)
          : null,
    },
    registry: {
      getAll: () =>
        new Map([
          [
            "journal",
            plugin("journal", {
              notes: { version: 1, search: { text: "body" } },
              private: { version: 1 },
            }),
          ],
          [
            "inactive",
            plugin("inactive", {
              notes: { version: 1, search: { text: "t" } },
            }),
          ],
          [
            // Confirmed, but nothing provides what it requires.
            "dependent",
            plugin(
              "dependent",
              { notes: { version: 1, search: { text: "t" } } },
              "loaded",
              ["missing@1"],
            ),
          ],
          [
            "broken",
            plugin(
              "broken",
              { notes: { version: 1, search: { text: "t" } } },
              "error",
            ),
          ],
        ]),
    },
  });
  expect(await resolve("session")).toEqual([
    { pluginId: "journal", namespace: "notes", textField: "body" },
  ]);
  expect(await resolve("missing")).toEqual([]);
});
