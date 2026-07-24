/**
 * mimo-tts entry module — declared via the root PLUGIN.md `entry` field.
 *
 * Registers the MiMo TTS speech wire through the unified plugin API
 * (`covel.registerWires`, namespaced to `mimo-tts/mimo`) instead of the
 * sunsetting `wires` frontmatter shim. The wire factory takes the framework
 * HTTP helpers (`covel.http` = { fetchWithRetry, validateBaseUrl }) so the
 * module needs no @covel/ai-provider import.
 */

import buildWires from "../lib/wires.js";

export default function register(covel) {
  covel.registerWires(buildWires(covel.http));
}
