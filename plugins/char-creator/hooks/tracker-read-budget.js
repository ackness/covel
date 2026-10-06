/**
 * A hook has no locale. The framework preamble that opens the system prompt
 * is in the instruction language of the session, so its language is the one
 * to add text in.
 */
const readsChinese = (messages) =>
  messages.some(
    (message) =>
      message.role === "system" &&
      typeof message.content === "string" &&
      /^\[RUNTIME\] [^\n]*\p{Script=Han}/u.test(message.content),
  );

/** Allow one detail read, reserving subsequent steps for writes and correction. */
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
          content: readsChinese(payload.messages)
            ? "角色详情已读取完毕。调用 sync-characters 提交已确认的变化；没有任何变化有依据时，用空数组调用。同步失败后，改正并重新提交整批内容。不要再请求更多角色详情，也不要编造缺失的值。"
            : "The character detail read is complete. Call sync-characters with the confirmed changes, or with empty arrays when no change is supported. After a failed sync, correct and resubmit the full batch. Do not request more character details or invent missing values.",
        },
      ],
    },
  };
}
