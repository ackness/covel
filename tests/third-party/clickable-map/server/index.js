/**
 * Server entry — puts where the player is into the session summary, so it
 * shows in the status strip or on the scene HUD without opening the map.
 */
import { MAP_KEY, MAP_NAMESPACE, readState } from "../lib/map.js";

export default function (covel) {
  covel.provideExtension("ui.slot@1", "summary", {
    async handler({ previous }, ctx) {
      // Summary providers run as a chain: keep what earlier ones supplied.
      // (`appendSummaryEntries` from `@covel/plugin-handlers-utils` does the
      // same; this package has no dependencies, so it does it by hand.)
      const earlier = previous?.entries ?? [];
      const state = readState(await ctx.pluginData.get(MAP_NAMESPACE, MAP_KEY));
      const place = state?.places.find((item) => item.id === state.current);
      if (!place) return { entries: earlier };
      return {
        entries: [
          ...earlier,
          {
            id: "clickable-map.location",
            kind: "text",
            label: { zh: "位置", en: "Location" },
            value: place.name,
          },
        ],
      };
    },
  });
}
