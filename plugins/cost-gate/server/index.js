/**
 * Unified server entry (PLUGIN.md `entry`) — registers cost-gate's
 * lifecycle hooks (enforce groups preserved from the legacy frontmatter).
 */
import accumulateUsage from "../hooks/accumulate-usage.js";
import trimDownstream from "../hooks/trim-downstream.js";
import enforceCap from "../hooks/enforce-cap.js";
import cleanup from "../hooks/cleanup.js";

export default function (covel) {
  covel.on("PostLLMResponse", accumulateUsage, { enforce: "post" });
  covel.on("PreSchedule", trimDownstream);
  covel.on("TurnStart", enforceCap, { enforce: "pre" });
  covel.on("SessionEnd", cleanup);
}
