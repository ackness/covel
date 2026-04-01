import type { ContextProviderInput } from "@covel/plugin-runtime";

/**
 * Inject guidance instructions telling the LLM when and how to use the choices tool.
 */
export async function guideContextProvider(input: ContextProviderInput) {
  const isZh = input.locale.startsWith("zh");

  return {
    id: "guide-instructions",
    title: isZh ? "引导选择指令" : "Guide & Choices Instructions",
    content: isZh
      ? [
          "## 互动引导规则",
          "在以下情况中，你应该调用 `generate-choices` 工具为玩家生成结构化选项：",
          "1. **关键决策点**：当叙事到达分岔路口，玩家需要做出有明确后果的选择时。",
          "2. **初次进入新场景**：玩家刚到达新地点或遭遇新情况时，提供初始行动选项。",
          "3. **对话选择**：当NPC提出问题或提议，玩家需要回应时。",
          "4. **危险警告**：当玩家即将面临高风险行动时，提供谨慎和冒险两类选项。",
          "",
          "调用 `generate-choices` 时，`topic` 参数应简洁描述当前决策的核心（如‘码头搜查方式’、‘对NPC的回应’）。",
          "",
          "注意：不要在每次回复都生成选项。如果玩家正在执行一个明确的行动，直接推进叙事即可。",
        ].join("\n")
      : [
          "## Guidance Rules",
          "Call the `generate-choices` tool to generate structured options for the player in these situations:",
          "1. **Key decision points**: When the narrative reaches a fork with meaningful consequences.",
          "2. **New scene entry**: When the player arrives at a new location or encounters a new situation.",
          "3. **Dialogue choices**: When an NPC asks a question or makes a proposal requiring a response.",
          "4. **Danger warnings**: When the player faces high-risk actions, offer both cautious and bold options.",
          "",
          "The `topic` parameter should concisely describe the core decision (e.g., 'dock search approach', 'response to NPC').",
          "",
          "Note: Do not generate options on every response. If the player is executing a clear action, just advance the narrative.",
        ].join("\n"),
    priority: 50,
  };
}
