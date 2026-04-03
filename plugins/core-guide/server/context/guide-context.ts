import { resolve } from "node:path";
import type { ContextProviderInput } from "@covel/plugin-runtime";
import { loadPrompt } from "@covel/context";

const PROMPTS_DIR = resolve(import.meta.dirname, "../../prompts");

/**
 * Inject guidance instructions telling the LLM when and how to use the choices tool.
 */
export async function guideContextProvider(input: ContextProviderInput): Promise<{
  id: string;
  title: string;
  content: string;
  priority: number;
}> {
  const isZh = input.locale.startsWith("zh");
  const content = await loadPrompt(PROMPTS_DIR, "guide-instructions", input.locale);

  return {
    id: "guide-instructions",
    title: isZh ? "引导选择指令" : "Guide & Choices Instructions",
    content,
    priority: 50,
  };
}
