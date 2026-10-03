import {
  MAP_KEY,
  MAP_NAMESPACE,
  defaultState,
  readState,
} from "../../lib/map.js";

/** Seeds the map once; opening the panel again changes nothing. */
export default async function (ctx) {
  const stored = await ctx.pluginData.get(MAP_NAMESPACE, MAP_KEY);
  if (readState(stored?.value))
    return { outcome: "success", value: { charted: false } };
  await ctx.pluginData.set(MAP_NAMESPACE, MAP_KEY, defaultState());
  return { outcome: "success", value: { charted: true } };
}
