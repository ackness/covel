/**
 * Explicit per-run policy for the agent tool-call loop.
 *
 * Everything the loop needs to decide HOW to run — tool surface, response
 * format, model override, streaming gate, step/retry budgets, tool-use
 * enforcement — is derived here, in one place, from the manifest + turn
 * input. The loop body (`turn-agent-tool-loop.ts`) only consumes the
 * resulting `AgentLoopPolicy`, so its `while` reads as control flow rather
 * than policy derivation, and the loop core can be instantiated in tests
 * with a hand-built policy + minimal `AgentLoopDeps` fixture.
 *
 * Roadmap W3 — docs/superpowers/specs/2026-07-10-agent-core-refactor-roadmap.md.
 */

import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import type {
  LLMResponseFormat,
  LLMToolDefinition,
} from "../llm/llm-adapter.js";
import { buildToolDefinitions } from "../turn-executor/turn-executor-helpers.js";
import { buildRetryPolicy, type RetryPolicy } from "../retry/llm-retry.js";
import type { AgentLoopDeps } from "../turn-executor/turn-executor-types.js";

export interface AgentLoopPolicy {
  /** LLM tool definitions built from manifest declarations (once per run). */
  readonly toolDefs: readonly LLMToolDefinition[] | undefined;
  /** JSON-schema response format when the runtime declares an output schema. */
  readonly responseFormat: LLMResponseFormat | undefined;
  /**
   * PR-6 session/API model override for this runtime. Story runtimes honour
   * the legacy story-only API override; every runtime kind honours the
   * per-session `runtimeModelOverrides` snapshot.
   */
  readonly runtimeModelOverride: string | undefined;
  /**
   * Stream only for story-output runtimes. Plugin runtimes' raw LLM text is
   * reasoning chatter that feeds into structured tool calls — it should never
   * reach the user's narrative feed. Story runtimes that also declare tools
   * still stream; the request layer falls back to generate() when the
   * provider cannot parse tool calls out of stream chunks.
   */
  readonly useStreaming: boolean;
  /**
   * Per-runtime maxSteps override. Plugins that should call a tool once and
   * stop (e.g. guide) set `maxSteps: 2` in their frontmatter.
   */
  readonly effectiveMaxSteps: number;
  /**
   * Smart retry policy derived from manifest (maxRetries / callTimeoutMs /
   * firstTokenTimeoutMs / loopDetectionThreshold). Also carries the
   * tool-loop-detection threshold consumed by `guardAgainstToolLoop`.
   */
  readonly retryPolicy: RetryPolicy;
  /** Nudge a bare (no-tool-call) finish back into the loop once. */
  readonly requireToolUse: boolean;
}

export interface BuildAgentLoopPolicyOptions {
  readonly manifest: RuntimeManifest;
  readonly input: TurnInput;
  readonly loaded: LoadedRuntime;
  readonly deps: AgentLoopDeps;
  readonly maxSteps: number;
  readonly timeoutMs: number;
}

export function buildAgentLoopPolicy({
  manifest,
  input,
  loaded,
  deps,
  maxSteps,
  timeoutMs,
}: BuildAgentLoopPolicyOptions): AgentLoopPolicy {
  // The ToolCallContext is passed so the executor can surface session-
  // specific tool variants (e.g. character tools with schema-typed fields).
  const toolDefs = deps.toolExecutor
    ? buildToolDefinitions(manifest, deps.toolExecutor, {
        sessionId: input.sessionId,
        turnId: input.turnId,
        pluginId: manifest.pluginId,
        runtimeId: manifest.name,
      })
    : undefined;

  const sessionRuntimeSlot = input.runtimeModelOverrides?.[manifest.name];
  const runtimeModelOverride =
    input.modelOverride && manifest.outputKind === "story"
      ? input.modelOverride
      : sessionRuntimeSlot;

  return {
    toolDefs,
    responseFormat: loaded.outputSchema
      ? { type: "json_schema" as const, schema: loaded.outputSchema }
      : undefined,
    runtimeModelOverride,
    useStreaming: !!(
      deps.onDelta &&
      deps.llm.stream &&
      manifest.outputKind === "story"
    ),
    effectiveMaxSteps: manifest.maxSteps ?? maxSteps,
    retryPolicy: buildRetryPolicy({
      maxRetries: manifest.maxRetries,
      callTimeoutMs: manifest.callTimeoutMs,
      firstTokenTimeoutMs: manifest.firstTokenTimeoutMs,
      loopDetectionThreshold: manifest.loopDetectionThreshold,
      runtimeTimeoutMs: timeoutMs,
    }),
    requireToolUse: manifest.requireToolUse === true,
  };
}
