import {
  instructionLocaleFor,
  type LLMToolCall,
  type RuntimeManifest,
  type ToolCallRecord,
} from "@covel/shared";
import { runReviewAgentOutputHook } from "../hooks/wire-helpers.js";
import { isRecord } from "../utils/is-record.js";
import type { AgentOutputContract } from "./agent-output-contract.js";
import type { CorrectionKind } from "./correction-policy.js";
import { submissionSyntaxProblems } from "./output-format-diagnostics.js";
import { schemaAsksForSegments, storyOutputProblems } from "./story-output.js";

export interface OutputRejection {
  readonly code:
    | "invalid-json"
    | "invalid-output"
    | "required-work"
    | "review-rejected"
    | "submission-batch";
  readonly reason:
    OutputRejection["code"] | "missing-submission" | "superseded";
  readonly correction: CorrectionKind | undefined;
  readonly message: string;
}

export function rejectOutput(
  code: OutputRejection["code"],
  message: string,
  reason: OutputRejection["reason"] = code,
): OutputRejection {
  return {
    code,
    reason,
    message: message.slice(0, 2000),
    correction:
      reason === "superseded"
        ? undefined
        : code === "review-rejected"
          ? "review"
          : code === "required-work"
            ? "toolUse"
            : "outputRepair",
  };
}

function freezeCandidate<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeCandidate(child);
    Object.freeze(value);
  }
  return value;
}

/** Strict shape validation, required work, then one review of an owned candidate. */
export async function evaluateSubmission(args: {
  readonly contract: AgentOutputContract;
  readonly manifest: RuntimeManifest;
  readonly call: LLMToolCall;
  readonly originalCall: LLMToolCall;
  readonly requiredWorkMet: boolean;
  readonly publicToolResults: readonly ToolCallRecord[];
  readonly hookOpts: Parameters<typeof runReviewAgentOutputHook>[0];
  readonly locale?: string;
}): Promise<
  | { readonly candidate: Readonly<Record<string, unknown>> }
  | { readonly rejection: OutputRejection }
> {
  const zh = instructionLocaleFor(args.locale) === "zh";
  let candidate: unknown;
  try {
    candidate = JSON.parse(args.call.arguments);
  } catch (error) {
    return {
      rejection: rejectOutput(
        "invalid-json",
        (await submissionSyntaxProblems(error, args.locale)).join("; "),
      ),
    };
  }
  if (!isRecord(candidate))
    return {
      rejection: rejectOutput(
        "invalid-output",
        zh
          ? "参数必须是一个完整 JSON 对象。"
          : "Arguments must be one complete JSON object.",
      ),
    };
  const validation = args.contract.validate(candidate);
  if (!validation.valid)
    return {
      rejection: rejectOutput(
        "invalid-output",
        (validation.errors ?? ["Output does not match the tool schema."])
          .slice(0, 5)
          .map((error) => error.slice(0, 200))
          .join("; "),
      ),
    };
  if (args.manifest.outputKind === "story") {
    const problems = storyOutputProblems(candidate, {
      segmentsRequired: schemaAsksForSegments(args.contract.schema),
      prose: false,
    });
    if (problems.length)
      return { rejection: rejectOutput("invalid-output", problems.join("; ")) };
  }
  if (!args.requiredWorkMet) {
    const tools = args.contract.requiredWork.toolNames.join(", ");
    return {
      rejection: rejectOutput(
        "required-work",
        zh
          ? `请先成功完成必需的业务工具工作${tools ? `（${tools}）` : ""}，并解决失败的业务调用，然后重新提交。不要重复已成功的写入。`
          : `Complete required business tool work${tools ? ` (${tools})` : ""} successfully and resolve failed business calls before submitting. Do not repeat successful writes.`,
      ),
    };
  }
  const owned = freezeCandidate(structuredClone(candidate));
  const correction = await runReviewAgentOutputHook(args.hookOpts, {
    output: owned,
    toolCall: { id: args.originalCall.id, name: args.originalCall.name },
    // Copy only public, JSON-owned fields. Never pass hidden commit artifacts,
    // model-private child values or arbitrary record metadata to reviewers.
    toolResults: args.publicToolResults
      .filter((call) => call.toolName !== args.contract.toolName)
      .map((call) => ({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: JSON.parse(JSON.stringify(call.output ?? null)) as unknown,
      })),
  });
  return correction
    ? { rejection: rejectOutput("review-rejected", correction) }
    : { candidate: owned };
}
