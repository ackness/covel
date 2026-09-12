/** Reserve the second tracker step for a write or an explicit no-op. */
export default function trackerReadBudget(_ctx, payload) {
  if (payload.runtimeId !== "char-creator/character-tracker") {
    return { action: "continue" };
  }
  const hasRead = payload.messages.some(
    (message) =>
      message.role === "assistant" &&
      message.toolCalls?.some((call) => call.name === "get-character"),
  );
  if (!hasRead) return { action: "continue" };
  return {
    action: "continue",
    replace: {
      tools: payload.tools?.filter((tool) => tool.name !== "get-character"),
      messages: [
        ...payload.messages,
        {
          role: "system",
          content:
            "The character detail read is complete. This is the final step: call sync-characters once with confirmed changes, or runtime-done when no changes are supported. Do not request more character details or invent missing values.",
        },
      ],
    },
  };
}
