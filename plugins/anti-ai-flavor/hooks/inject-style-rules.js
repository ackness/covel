import { buildStyleRulesText } from "./_style-rules.js";

/** zh-CN and its registered aliases; see styleLanguage below. */
const ZH_STYLE_LOCALES = new Set(["zh-cn", "zh", "zh-hans"]);

/**
 * Map a session locale to a style-rule table. zh-CN and its registered
 * aliases ("zh", "zh-Hans", mirrored from the framework locale registry's
 * `isDefaultLocale`) get the zh table; any `en*` locale gets the en table;
 * everything else gets nothing. Inlined on purpose: community plugins are
 * imported from the user plugins dir (`~/.covel/plugins/<id>`), where bare
 * `@covel/*` specifiers do NOT resolve — shipped server code must be
 * self-contained.
 *
 * @param {string | undefined} locale
 * @returns {"zh" | "en" | null}
 */
function styleLanguage(locale) {
  if (typeof locale !== "string") return null;
  const normalized = locale.trim().toLowerCase().replace(/_/g, "-");
  if (ZH_STYLE_LOCALES.has(normalized)) return "zh";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  return null;
}

/**
 * PostContextAssembly — append the anti-AI-flavor style rules to the **story**
 * runtime's assembled system prompt, so the main narrative voice gets the
 * constraints a single time per turn (after buildContext, before the agent
 * loop).
 *
 * Story is identified by `payload.outputKind === "story"` — a read-only field
 * the framework threads into the PostContextAssembly payload — never by a
 * hardcoded plugin id (framework/plugin isolation rule). Every non-story
 * runtime (codex / guide / extractors / system) returns a plain `continue`
 * and is left byte-for-byte unchanged.
 *
 * zh and en sessions only: the zh table targets Chinese prose conventions and
 * the en table targets English AI-slop patterns, so injection is gated on
 * `styleLanguage(payload.locale)` instead of polluting prompts of sessions
 * writing in other languages.
 *
 * Pure rewrite: this hook only appends to the system prompt it is handed. It
 * never reads or writes the store, never emits proposals, and never calls the
 * LLM. Prevention-only by design — generated output is never inspected.
 *
 * `ctx.getOwnSettings()` is injected by the runtime hook pipeline and returns
 * this plugin's resolved per-session settings; it is absent outside an active
 * hook scope, where the optional call degrades to the manifest defaults
 * (every rule ON).
 *
 * @param {{ sessionId: string, getOwnSettings?: () => Record<string, unknown> }} ctx
 * @param {{ outputKind?: string, systemPrompt: string, locale?: string }} payload
 * @returns {Promise<{ action: "continue", replace?: { systemPrompt: string } }>}
 */
export default async function injectStyleRules(ctx, payload) {
  if (payload?.outputKind !== "story") return { action: "continue" };
  const lang = styleLanguage(payload?.locale);
  if (!lang) return { action: "continue" };
  const rulesText = buildStyleRulesText(ctx?.getOwnSettings?.(), lang);
  if (!rulesText) return { action: "continue" };
  return {
    action: "continue",
    replace: { systemPrompt: payload.systemPrompt + "\n\n" + rulesText },
  };
}
