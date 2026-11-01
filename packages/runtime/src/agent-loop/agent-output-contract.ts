import { instructionLocaleFor, type LLMToolDefinition } from "@covel/shared";
import {
  resolveAgentOutput,
  type EffectiveAgentOutput,
  type LoadedRuntime,
} from "@covel/shared/plugin-runtime";
import { validateOutput, type ValidationResult } from "@covel/tools";

/** Run-local control contract; the loop owns acceptance, never a business tool module. */
export interface AgentOutputContract extends EffectiveAgentOutput {
  readonly validate: (candidate: unknown) => ValidationResult;
}
const contracts = new WeakMap<LoadedRuntime, AgentOutputContract>();

export function agentOutputContract(
  loaded: LoadedRuntime,
): AgentOutputContract {
  const existing = contracts.get(loaded);
  if (existing) return existing;
  const effective = resolveAgentOutput(loaded);
  // Compile now so malformed author schemas fail admission before a model call.
  try {
    validateOutput({}, effective.schema);
  } catch (cause) {
    throw new Error(
      `io.output.schema: invalid submit-output schema: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  const contract = Object.freeze({
    ...effective,
    validate: (candidate: unknown) =>
      validateOutput(candidate, effective.schema),
  });
  contracts.set(loaded, contract);
  return contract;
}

export function outputToolDefinition(
  output: EffectiveAgentOutput,
  locale?: string,
): LLMToolDefinition {
  return {
    name: output.toolName,
    description:
      instructionLocaleFor(locale) === "zh"
        ? "在完成必需的工具工作后，提交本 runtime 的最终结果。参数必须符合此 schema。若提交被拒绝，请修正报告的问题并再次调用此工具。提交成功会结束 runtime，但不代表更改已经保存。"
        : "Submit the final result for this runtime after required tool work is complete. Arguments must match this schema. If the submission is rejected, correct the reported problems and call this tool again. A successful submission ends the runtime; it does not confirm that changes have been saved.",
    parameters: output.schema,
    strict: "auto",
  };
}
