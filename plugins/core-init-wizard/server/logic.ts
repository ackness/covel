import type { CharacterCreateInput } from "@covel/shared";

/**
 * Build a prompt asking the LLM to write a narrative transition
 * from the opening story into a character name question.
 */
export function buildTransitionPrompt(
  narrative: string,
  locale: string,
): string {
  const isZh = locale.startsWith("zh");

  if (isZh) {
    return `你是一个RPG游戏的角色创建引导者。下面是刚生成的开场叙事：

---
${narrative}
---

请写1-2句话，承接上面叙事的氛围和情境，自然地引出"你叫什么名字"这个问题。
要求：
- 用第二人称"你"
- 不要重复叙事内容，从某个细节延伸
- 让名字的询问成为故事的一部分，不要生硬地说"请输入你的名字"
- 只输出过渡文字，不要输出其他内容`;
  }

  return `You are an RPG character creation guide. Here is the opening narrative:

---
${narrative}
---

Write 1-2 sentences that continue the narrative's atmosphere and naturally lead to asking "what is your name?".
Requirements:
- Use second person "you"
- Don't repeat the narrative, extend from a detail
- Make the name question part of the story
- Output only the transition text`;
}

/**
 * Return a static fallback transition when LLM is unavailable.
 */
export function buildFallbackTransition(locale: string): string {
  const isZh = locale.startsWith("zh");
  return isZh
    ? "在这一切开始之前——你叫什么名字？"
    : "Before all this begins — what is your name?";
}

/**
 * Build the character creation UI block proposal payload.
 */
export function buildCharacterCreationBlock(locale: string): {
  kind: string;
  payload: unknown;
} {
  const isZh = locale.startsWith("zh");

  return {
    kind: "ui.render",
    payload: {
      type: "character_creation",
      content: {
        fields: [
          {
            id: "character_name",
            type: "text",
            label: isZh ? "你的名字" : "Your Name",
            placeholder: isZh ? "键入你的名字..." : "Type your name...",
            required: true,
          },
        ],
        submitLabel: isZh ? "确认" : "Confirm",
        submitMapping: {
          character_name: "name",
        } satisfies Record<string, keyof CharacterCreateInput>,
      },
    },
  };
}
