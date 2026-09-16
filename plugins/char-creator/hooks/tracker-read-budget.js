/** Reserve the second tracker step for a write or an explicit no-op. */
export default function trackerReadBudget(_ctx, payload) {
  if (payload.runtimeId !== "char-creator/character-tracker") {
    return { action: "continue" };
  }
  const tools = payload.tools?.map((tool) => {
    if (tool.name !== "sync-characters") return tool;
    const schema = tool.parameters;
    const updates = schema?.properties?.updates;
    if (!updates?.items?.properties) return tool;
    const {
      name: _name,
      type: _type,
      description: _description,
      ...properties
    } = updates.items.properties;
    return {
      ...tool,
      parameters: {
        ...schema,
        properties: {
          ...schema.properties,
          updates: { ...updates, items: { ...updates.items, properties } },
        },
      },
    };
  });
  const hasRead = payload.messages.some(
    (message) =>
      message.role === "assistant" &&
      message.toolCalls?.some((call) => call.name === "get-character"),
  );
  if (!hasRead) return { action: "continue", replace: { tools } };
  return {
    action: "continue",
    replace: {
      tools: tools?.filter((tool) => tool.name !== "get-character"),
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
