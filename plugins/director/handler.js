/**
 * director has no schedulable runtime — it works purely through the
 * PostContextAssembly lifecycle hook declared in PLUGIN.md
 * (./hooks/inject-preamble.js). This no-op handler exists only so the
 * `runtimeType: function` manifest is complete; the runtime is
 * `trigger: manual` and is never scheduled.
 *
 * @returns {Promise<Record<string, unknown>>}
 */
export default async function handler() {
  return {};
}
