import { interpolate, loadPrompt } from "@covel/context";

/**
 * Load the externalized system prompt for LLM-driven world generation.
 *
 * The LLM receives only a concept string and autonomously decides all details:
 * id, name, tags, dimensions, and lore.
 */
export async function buildWorldPrompt(
  concept: string,
  locale: string,
): Promise<string> {
  const lang =
    locale === "zh-CN" ? "中文" : locale === "en-US" ? "English" : locale;

  const template = await loadPrompt("server", "generate-world");
  return interpolate(template, {
    concept,
    locale,
    language: lang,
  });
}
