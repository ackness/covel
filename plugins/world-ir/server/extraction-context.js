/**
 * Fact extraction consumes a typed current-turn input. Full history and memory
 * duplicate prior facts, expand latency, and encourage extracting old changes.
 * Keep known names as disambiguation data, never as evidence of a new event.
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
  return {
    action: "continue",
    replace: {
      systemPrompt: payload.promptTemplate,
      messages: [
        {
          role: "user",
          content: JSON.stringify({ narrative, characters }),
        },
      ],
    },
  };
}
