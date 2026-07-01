import { preambleForLocale } from "./_preamble.js";

/**
 * PostContextAssembly — append the director preamble to the **story** runtime's
 * assembled system prompt, so the main narrative voice gets directing guidance
 * a single time per turn (after buildContext, before the agent loop).
 *
 * Story is identified by `payload.outputKind === "story"` — a read-only field
 * the framework threads into the PostContextAssembly payload — never by a
 * hardcoded plugin id (framework/plugin isolation rule). Every non-story runtime
 * (codex / guide / extractors / system) returns a plain `continue` and is left
 * byte-for-byte unchanged.
 *
 * Pure rewrite: this hook only reshapes the system prompt it is handed. It never
 * reads or writes the store, never emits proposals, and never calls the LLM.
 *
 * The preamble is localized to `payload.locale` so it matches the otherwise
 * locale-resolved story prompt instead of always injecting English.
 *
 * @param {{ sessionId: string }} _ctx
 * @param {{ outputKind?: string, systemPrompt: string, locale?: string }} payload
 * @returns {Promise<{ action: "continue", replace?: { systemPrompt: string } }>}
 */
export default async function injectPreamble(_ctx, payload) {
  if (payload?.outputKind !== "story") return { action: "continue" };
  const preamble = preambleForLocale(payload.locale);
  return {
    action: "continue",
    replace: { systemPrompt: payload.systemPrompt + "\n\n" + preamble },
  };
}
