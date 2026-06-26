/**
 * cost-gate has no schedulable runtime — it works purely through the lifecycle
 * hooks declared in PLUGIN.md (PostLLMResponse / PreSchedule / TurnStart /
 * SessionEnd). This no-op handler exists only so the `runtimeType: function`
 * manifest is complete; the runtime is `trigger: manual` and is never scheduled.
 *
 * @returns {Promise<Record<string, unknown>>}
 */
export default async function handler() {
  return {};
}
