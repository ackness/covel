import { characterHandles } from "../tools/character-handles.js";
import { vocabularyEntries } from "../tools/vocabulary.js";

/**
 * Fact extraction consumes a typed current-turn input. Full history and memory
 * duplicate prior facts, expand latency, and encourage extracting old changes.
 * Keep known names (characters and the tracked vocabulary) as disambiguation
 * data, never as evidence of a new event. Characters carry short word handles
 * in place of their ids (see `character-handles.js`).
 *
 * NOTE: This Hook is retained by design (08 §4.7). It prunes history/memory
 * to prevent re-extracting old facts, which is a legitimate context trimming
 * use case allowed by the extension architecture (02 §2 "裁剪已有上下文").
 */
export default async function extractionContext(ctx, payload) {
  if (ctx.runtimeId !== "world-ir") return { action: "continue" };
  const narrative = payload.inputSlots?.narrative;
  if (
    narrative?.cardinality !== "one" ||
    typeof narrative.value !== "string" ||
    !payload.promptTemplate
  ) {
    return { action: "continue" };
  }
  const characters = [...characterHandles(payload.characters ?? [])].map(
    ([handle, { name, type }]) => ({ id: handle, name, type }),
  );
  const vocabulary = vocabularyEntries(payload.inputSlots?.vocabulary);
  return {
    action: "continue",
    replace: {
      systemPrompt: payload.promptTemplate,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            // Only the text: the result id, plugin id and runtime id are
            // bookkeeping the model has no use for.
            narrative: {
              cardinality: narrative.cardinality,
              value: narrative.value,
            },
            characters,
            ...(vocabulary.length ? { vocabulary } : {}),
          }),
        },
      ],
    },
  };
}
