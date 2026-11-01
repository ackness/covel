import { ToolError, type SubagentResult } from "@covel/shared";
import {
  delegateBatchEnvelopeSchema,
  delegateParametersSchema,
  parseJsonText,
} from "@covel/tools";
import { forkWorldModelView } from "../function-runtime/world-model-view.js";
import { characterByName } from "../orchestration/policy-tools.js";
import { renderToolSuccess } from "./tool-result-text.js";
import {
  emitToolEvent,
  failed,
  type SubagentDelegateScope,
} from "./subagent-delegate.js";
import type { SubagentRunArgs, SubagentRunner } from "./subagent-runner.js";
import type {
  ToolCall,
  ToolCallContext,
  ToolCallResult,
} from "./tool-executor.js";

/** One speculative publication boundary, containing independent child scopes. */
export async function runDelegateBatch(
  call: ToolCall,
  context: ToolCallContext,
  runner: SubagentRunner,
  scope: SubagentDelegateScope,
): Promise<ToolCallResult> {
  const startTime = Date.now();
  const assertLive = () => {
    context.signal?.throwIfAborted();
    scope.deps.turnControl?.signal?.throwIfAborted();
    scope.deps.turnControl?.executionSignal?.throwIfAborted();
  };
  assertLive();
  let raw: unknown;
  try {
    raw = parseJsonText(call.arguments);
  } catch {
    return failed(call, context, startTime, {
      ok: false,
      error: {
        code: "invalid-input",
        message: "Batch arguments are not valid JSON",
      },
    });
  }

  const envelope = delegateBatchEnvelopeSchema.safeParse(raw);
  if (!envelope.success)
    return failed(call, context, startTime, {
      ok: false,
      error: {
        code: "invalid-input",
        message: "Batch requires only requests, an array of 1–32 entries",
      },
    });

  // Capture once, before the first tracing/loading await. Children fork this
  // owned snapshot; successful evidence remains speculative until publication.
  const world = context.world
    ? forkWorldModelView(context.world, assertLive)
    : undefined;
  const operations = scope.operations?.child();
  let accepted = false;
  try {
    const requests: SubagentRunArgs[] = envelope.data.requests.map(
      (entry, batchIndex) => {
        const base = {
          caller: scope.caller,
          input: scope.input,
          deps: scope.deps,
          executionContext: scope.executionContext,
          parentCallId: call.toolCallId,
          batchIndex,
          world: world?.world,
          operations,
          parentSignal: context.signal,
        };
        const parsed = delegateParametersSchema.safeParse(entry);
        if (!parsed.success)
          return {
            ...base,
            request: entry,
            refusal: {
              code: "invalid-input",
              message: "The delegate request is invalid",
            },
          };
        let characterId: string | undefined;
        if (parsed.data.character !== undefined) {
          try {
            // Name lookup is a real parent observation, outside child speculation.
            characterId = characterByName(
              context.world,
              parsed.data.character,
            ).id;
          } catch (error) {
            if (!(error instanceof ToolError)) throw error;
            return {
              ...base,
              request: entry,
              refusal: {
                code: error.code === "ambiguous" ? "ambiguous" : "not-found",
                message: error.message,
              },
            };
          }
        }
        const { target, brief, data, instruction, maxSteps } = parsed.data;
        return {
          ...base,
          request: {
            target,
            brief,
            ...(data !== undefined ? { data } : {}),
            ...(instruction !== undefined ? { instruction } : {}),
            ...(characterId !== undefined ? { characterId } : {}),
            ...(maxSteps !== undefined ? { budget: { maxSteps } } : {}),
          },
        };
      },
    );
    await emitToolEvent(context, call, "tool.calling", {
      arguments: call.arguments,
      source: "builtin",
    });
    assertLive();
    const outcomes = await runner.runBatch(requests);
    assertLive();
    // Usage and stop provenance belong to child traces, never model receipts.
    const output = {
      results: outcomes.map((result: SubagentResult) =>
        result.ok
          ? { ok: true as const, output: result.output }
          : { ok: false as const, error: result.error },
      ),
    };
    const staged = operations?.held() ?? [];
    const result = renderToolSuccess({
      content: output,
      locale: scope.input.locale,
      stagedOperations: {
        count: staged.length,
        kinds: staged.flatMap((op) => op.writes.map((w) => w.type)),
      },
    });
    await emitToolEvent(context, call, "tool.completed", {
      result,
      parsedResult: output,
      durationMs: Date.now() - startTime,
      success: true,
    });
    assertLive();
    world?.accept();
    operations?.commit();
    accepted = true;
    return {
      toolCallId: call.toolCallId,
      name: call.name,
      result,
      parsedResult: output,
      success: true,
      approvalStatus: "auto-allowed",
    };
  } finally {
    if (!accepted) operations?.discard();
    world?.discard();
  }
}
