import { instructionLocaleFor, type LLMMessage } from "@covel/shared";
import type { ResolvedLoopProfile } from "./loop-profile.js";

/** Ask for the configured answer, tools off. */
export function answerWithoutTools(
  answerPrompt: ResolvedLoopProfile["answerPrompt"],
  locale: string | undefined,
  options: { segments: boolean },
): LLMMessage {
  return answerPrompt === "story"
    ? writeStoryWithoutTools(locale, options)
    : finalAnswerWithoutTools(locale);
}

export function finalAnswerWithoutTools(
  locale: string | undefined,
): LLMMessage {
  return {
    role: "system",
    content:
      instructionLocaleFor(locale) === "zh"
        ? "已经没有剩余步数，工具已关闭。现在根据已有的信息直接给出最终答案，按要求的输出格式回复；不要再调用工具或解释处理过程。"
        : "No steps are left and tools are off. Give your final answer now from the information you already have, in the required output format. Do not call tools or describe the processing steps.",
  };
}

/** Ask a story runtime that has only called tools to write the narrative. */
export function writeStoryWithoutTools(
  locale: string | undefined,
  { segments }: { segments: boolean },
): LLMMessage {
  const zh = instructionLocaleFor(locale) === "zh";
  return {
    role: "system",
    content: segments
      ? zh
        ? "你只完成了工具调用，还没有输出故事正文。现在根据已读取的信息，以要求的 JSON 对象回复，将本回合正文放在 segments 数组中：每段一项，kind 为 narration、dialogue 或 action；对话项还要带 speaker。不要再调用工具或解释处理过程。"
        : "You completed tool calls but have not written the story. Reply now as the required JSON object, putting this turn's story in the segments array: one entry per paragraph with kind narration, dialogue or action; dialogue entries also need speaker. Use the information already retrieved. Do not call more tools or describe the processing steps."
      : zh
        ? "你只完成了工具调用，还没有输出故事正文。现在根据已读取的信息直接写出本回合正文；不要再调用工具或解释处理过程。"
        : "You completed tool calls but have not written the story. Write this turn's narrative now using the information already retrieved. Do not call more tools or describe the processing steps.",
  };
}
