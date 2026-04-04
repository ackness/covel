import type { ContextProviderInput } from "@covel/plugin-runtime";
import {
  getRecentImageSummary,
  EMPTY_STATE,
  type ImageState,
} from "./image-logic.js";

/**
 * Context provider that injects recent image history into the runtime context.
 * This allows other runtimes to maintain visual continuity.
 */
export async function imageContextProvider(
  input: ContextProviderInput,
): Promise<unknown> {
  const isZh = input.locale.startsWith("zh");
  const state = input.state as Record<string, unknown> | undefined;
  const imageState =
    (state?.["core-image"] as ImageState) ?? EMPTY_STATE;

  const summary = getRecentImageSummary(imageState, input.locale);

  return {
    id: "image-history",
    title: isZh ? "最近生成的插画" : "Recent Image History",
    content: summary,
    priority: 40,
  };
}
