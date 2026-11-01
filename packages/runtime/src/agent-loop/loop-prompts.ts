import { instructionLocaleFor, type LLMMessage } from "@covel/shared";

/** The same completion request for every agent, including the reserve step. */
export function submitOutputPrompt(locale?: string): LLMMessage {
  return {
    role: "system",
    content:
      instructionLocaleFor(locale) === "zh"
        ? "请调用 submit-output 提交符合工具 schema 的完整最终结果。只调用这一个工具，不要把答案写在普通回复里。不要重复已成功的业务写入。"
        : "Call submit-output with the complete final result matching its schema. Make it the only call in the response; do not put the answer in ordinary content. Do not repeat successful business writes.",
  };
}
