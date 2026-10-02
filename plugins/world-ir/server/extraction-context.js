/**
 * Fact extraction consumes a typed current-turn input. Full history and memory
 * duplicate prior facts, expand latency, and encourage extracting old changes.
 * Keep known names (characters and the tracked vocabulary) as disambiguation
 * data, never as evidence of a new event.
 *
 * NOTE: This Hook is retained by design (08 §4.7). It prunes history/memory
 * to prevent re-extracting old facts, which is a legitimate context trimming
 * use case allowed by the extension architecture (02 §2 "裁剪已有上下文").
 */
export default async function extractionContext(_ctx, payload) {
  if (payload.runtimeId !== "world-ir") return { action: "continue" };
  const narrative = payload.inputSlots?.narrative;
  if (
    narrative?.cardinality !== "one" ||
    typeof narrative.value !== "string" ||
    !payload.promptTemplate
  ) {
    return { action: "continue" };
  }
  const characters = (payload.characters ?? []).map(({ id, name, type }) => ({
    id,
    name,
    type,
  }));
  const vocabulary = vocabularyEntries(payload.inputSlots?.vocabulary);
  return {
    action: "continue",
    replace: {
      systemPrompt: payload.promptTemplate,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            narrative,
            characters,
            ...(vocabulary.length ? { vocabulary } : {}),
          }),
        },
      ],
    },
  };
}

/** Names published by state plugins through `world-ir.vocabulary@1`. */
function vocabularyEntries(slot) {
  if (slot?.cardinality !== "all" || !Array.isArray(slot.items)) return [];
  return slot.items.flatMap((item) =>
    Array.isArray(item?.value?.entries) ? item.value.entries : [],
  );
}
