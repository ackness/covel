import {
  MAP_KEY,
  MAP_NAMESPACE,
  defaultState,
  readState,
  travel,
} from "../../lib/map.js";

/**
 * Applies one move. The widget only says where the player wants to go; whether
 * that is allowed is decided here, against the stored map.
 */
export default async function (ctx) {
  const locationId = ctx.triggerEvent?.data?.locationId;
  if (typeof locationId !== "string")
    return { outcome: "failed", error: "No place was selected" };
  const stored = await ctx.pluginData.get(MAP_NAMESPACE, MAP_KEY);
  const moved = travel(readState(stored?.value) ?? defaultState(), locationId);
  // A stale click (the map moved on) is not an error; it just changes nothing.
  if (!moved.ok)
    return {
      outcome: "success",
      value: { moved: false, reason: moved.reason },
    };
  await ctx.pluginData.set(MAP_NAMESPACE, MAP_KEY, moved.state);
  return { outcome: "success", value: { moved: true, current: locationId } };
}
