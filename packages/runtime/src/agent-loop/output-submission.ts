import type {
  LLMToolCall,
  RuntimeManifest,
  ToolCallRecord,
} from "@covel/shared";
import { runReviewAgentOutputHook } from "../hooks/wire-helpers.js";
import { isRecord } from "../utils/is-record.js";
import type { ExecutedToolCallState } from "../turn-executor/turn-output-helpers.js";
import type { AgentOutputContract } from "./agent-output-contract.js";
import type { CorrectionKind } from "./correction-policy.js";
import {
  loadOutputText,
  submissionSyntaxProblems,
} from "./output-format-diagnostics.js";
import { schemaAsksForSegments, storyOutputProblems } from "./story-output.js";
import {
  COMPLETION_CONFLICT_ERROR,
  splitAgentSubmission,
} from "./finalize-agent-output.js";

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
  readonly businessCalls: readonly ExecutedToolCallState[];
  readonly hookOpts: Parameters<typeof runReviewAgentOutputHook>[0];
  readonly locale?: string;
}): Promise<
  | { readonly candidate: Readonly<Record<string, unknown>> }
  | { readonly rejection: OutputRejection }
> {
  let candidate: unknown;
  if (args.contract.from) {
    // Arguments carry no output in this mode, even when the provider wraps
    // the advertised {} or emits malformed JSON. Only executor content counts.
    const tool = args.contract.from.tool;
    const source = [...args.businessCalls]
      .reverse()
      .find((call) => call.name === tool && call.success && !call.refused);
    if (!source)
      return {
        rejection: rejectOutput(
          "required-work",
          (await loadOutputText(args.locale))("source-required", { tool }),
        ),
      };
    candidate = source.result;
  } else {
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
          (await loadOutputText(args.locale))("object-required"),
        ),
      };
  }
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
  // The result can be any JSON value even though the admitted schema requires an object.
  if (!isRecord(candidate))
    return {
      rejection: rejectOutput(
        "invalid-output",
        (await loadOutputText(args.locale))("object-required"),
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
  // Check the business value finalization will commit: contradictory completion
  // fields and the public contract stay correctable inside the loop.
  const split = splitAgentSubmission(args.manifest, candidate, {
    silent: true,
  });
  if (split.kind === "invalid-output") {
    const text = await loadOutputText(args.locale);
    return {
      rejection: rejectOutput(
        "invalid-output",
        split.error === COMPLETION_CONFLICT_ERROR
          ? text("completion-conflict")
          : split.problems.join("; "),
      ),
    };
  }
  if (args.contract.validateContract) {
    const contractValidation = args.contract.validateContract(split.output);
    if (!contractValidation.valid)
      return {
        rejection: rejectOutput(
          "invalid-output",
          (await loadOutputText(args.locale))("contract-invalid", {
            contract: args.manifest.outputContract ?? "",
            problems: (
              contractValidation.errors ?? [
                "Output does not match the contract schema.",
              ]
            )
              .slice(0, 5)
              .map((error) => error.slice(0, 200))
              .join("; "),
          }),
        ),
      };
  }
  if (!args.requiredWorkMet) {
    const tools = args.contract.requiredWork.toolNames.join(", ");
    return {
      rejection: rejectOutput(
        "required-work",
        (await loadOutputText(args.locale))(
          tools ? "required-work-tools" : "required-work",
          { tools },
        ),
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
