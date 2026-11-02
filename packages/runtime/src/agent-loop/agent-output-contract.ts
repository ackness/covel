import type { LLMToolDefinition } from "@covel/shared";
import {
  resolveAgentOutput,
  type EffectiveAgentOutput,
  type LoadedRuntime,
} from "@covel/shared/plugin-runtime";
import { validateOutput, type ValidationResult } from "@covel/tools";
import { loadOutputText } from "./output-format-diagnostics.js";

/** Run-local control contract; the loop owns acceptance, never a business tool module. */
export interface AgentOutputContract extends EffectiveAgentOutput {
  readonly validate: (candidate: unknown) => ValidationResult;
  /**
   * The public `io.output.contract` schema, checked against the business value
   * (the submission minus protocol fields) before review, so a contract error
   * stays correctable. Finalization still re-checks it.
   */
  readonly validateContract?: (value: unknown) => ValidationResult;
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
  const contractSchema = loaded.outputContractSchema;
  if (contractSchema) {
    try {
      validateOutput({}, contractSchema);
    } catch (cause) {
      throw new Error(
        `io.output.contract: invalid contract schema: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }
  const contract: AgentOutputContract = Object.freeze({
    ...effective,
    validate: (candidate: unknown) =>
      validateOutput(candidate, effective.schema),
    ...(contractSchema
      ? {
          validateContract: (value: unknown) =>
            validateOutput(value, contractSchema),
        }
      : {}),
  });
  contracts.set(loaded, contract);
  return contract;
}

export async function outputToolDefinition(
  output: EffectiveAgentOutput,
  locale?: string,
): Promise<LLMToolDefinition> {
  const text = await loadOutputText(locale);
  return {
    name: output.toolName,
    description: output.from
      ? text("tool-source-description", { tool: output.from.tool })
      : text("tool-description"),
    parameters: output.from
      ? { type: "object", properties: {}, additionalProperties: false }
      : output.schema,
    strict: "auto",
  };
}
