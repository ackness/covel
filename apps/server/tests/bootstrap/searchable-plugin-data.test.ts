import { expect, it } from "vitest";
import { createSearchablePluginDataResolver } from "../../src/routes/api/bootstrap/searchable-plugin-data.js";

const plugin = (data: Record<string, unknown>, status = "loaded") =>
  ({ status, packageManifest: { plugin: { contributes: { data } } } }) as never;

it("lists the searchable namespaces of the plugins active in the session only", async () => {
  const resolve = createSearchablePluginDataResolver({
    store: {
      getSession: async (id) =>
        id === "session"
          ? ({ activePlugins: ["journal", "broken"] } as never)
          : null,
    },
    registry: {
      getAll: () =>
        new Map([
          [
            "journal",
            plugin({
              notes: { version: 1, search: { text: "body" } },
              private: { version: 1 },
            }),
          ],
          [
            "inactive",
            plugin({ notes: { version: 1, search: { text: "t" } } }),
          ],
          [
            "broken",
            plugin({ notes: { version: 1, search: { text: "t" } } }, "error"),
          ],
        ]),
    },
  });
  expect(await resolve("session")).toEqual([
    { pluginId: "journal", namespace: "notes", textField: "body" },
  ]);
  expect(await resolve("missing")).toEqual([]);
});
