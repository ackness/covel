/**
 * Explicit per-run policy for the agent tool-call loop.
 *
 * Everything the loop needs to decide HOW to run — tool surface, response
 * format, model override, streaming gate, step/retry budgets, tool-use
 * enforcement, and the loop profile (steering, fallback, finalizer) — is
 * derived here, in one place, from the manifest and turn input. The loop body (`turn-agent-tool-loop.ts`) only consumes the
 * resulting `AgentLoopPolicy`, so its `while` reads as control flow rather
 * than policy derivation, and the loop core can be instantiated in tests
 * with a hand-built policy + minimal `AgentLoopDeps` fixture.
 */

import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import type { LLMToolDefinition } from "@covel/shared";
import { buildToolDefinitions } from "../turn-executor/turn-executor-helpers.js";
import { declaredToolNames, resolveDeferredToolNames } from "./tool-search.js";
import { buildRetryPolicy, type RetryPolicy } from "../retry/retry-common.js";
import {
  resolveLoopProfile,
  type ResolvedLoopProfile,
} from "./loop-profile.js";
import type { AgentLoopDeps } from "../turn-executor/turn-executor-types.js";

import {
  agentOutputContract,
  type AgentOutputContract,
} from "./agent-output-contract.js";

export const DEFAULT_MAX_TOOL_STEPS = 20;

export interface AgentLoopPolicy {
  /**
   * LLM tool definitions built from manifest declarations (once per run).
   * When `deferredToolNames` is non-empty this is the REDUCED surface
   * (deferred schemas withheld, `search-tools` appended); the loop grows its
   * own working copy as searches activate tools mid-run.
   */
  readonly toolDefs: readonly LLMToolDefinition[];
  /**
   * Tool names withheld from the initial advertisement (`tools.defer`).
   * Non-empty ⇒ the loop intercepts `search-tools` calls and activates
   * matches from this pool for the rest of the run.
   */
  readonly deferredToolNames: ReadonlySet<string>;
  /** Final output is submitted only through the generated tool. */
  readonly output: AgentOutputContract;
  readonly responseFormat: undefined;
  /**
   * Session/API model override for this runtime. Story runtimes honour
   * the request-scoped story-only API override; every runtime kind honours the
   * per-session `runtimeModelOverrides` snapshot.
   */
  readonly runtimeModelOverride: string | undefined;
  /**
   * Use provider streaming whenever available, to track first-output/idle
   * timeouts and complete tool calls. Output remains internal until accepted
   * and committed; no transport delta is sent to the player.
   */
  readonly useStreaming: boolean;
  /**
   * Per-runtime maxSteps override, then caller budget, then the shared default.
   * Accepted output ends the loop regardless of this ceiling.
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
  /**
   * The resolved loop profile: whether text reaches the player, whether
   * queued player interjections are merged (the `story` preset only — plugin
   * runtimes run structured tasks an interjection would corrupt), whether a
   * cut reply is kept, the tool-loop fallback and the finalizer.
   */
  readonly profile: ResolvedLoopProfile;
  /**
   * The runtime's exact execution authorization set: its declared
   * tool names (deferred names included — deferring only withholds the
   * schema advertisement, never grants or removes authorization) plus the
   * host-generated submission tool.
   * Passed to the ToolExecutor on every call so execution — not just
   * advertisement — is bounded by the manifest declaration.
   */
  readonly authorizedToolNames: ReadonlySet<string>;
}

export interface BuildAgentLoopPolicyOptions {
  readonly manifest: RuntimeManifest;
  readonly input: TurnInput;
  readonly loaded: LoadedRuntime;
  readonly deps: AgentLoopDeps;
  readonly maxSteps: number;
  readonly timeoutMs: number;
}

export async function buildAgentLoopPolicy({
  manifest,
  input,
  loaded,
  deps,
  maxSteps,
  timeoutMs,
}: BuildAgentLoopPolicyOptions): Promise<AgentLoopPolicy> {
  const output = agentOutputContract(loaded);
  const toolDefs = await buildToolDefinitions(
    manifest,
    deps.toolExecutor,
    {
      sessionId: input.sessionId,
      turnId: input.turnId,
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      locale: input.locale,
    },
    output,
  );
  const authorizedToolNames = new Set(declaredToolNames(manifest));
  authorizedToolNames.add(output.toolName);

  // Output contract, not loop behaviour.
  const sessionRuntimeSlot = input.runtimeModelOverrides?.[manifest.name];
  const runtimeModelOverride =
    input.modelOverride && manifest.outputKind === "story"
      ? input.modelOverride
      : sessionRuntimeSlot;
  return {
    toolDefs,
    deferredToolNames: deps.toolExecutor
      ? resolveDeferredToolNames(manifest)
      : new Set<string>(),
    responseFormat: undefined,
    output,
    runtimeModelOverride,
    useStreaming: !!deps.llm.stream,
    effectiveMaxSteps: manifest.maxSteps ?? maxSteps,
    retryPolicy: buildRetryPolicy({
      maxRetries: manifest.maxRetries,
      callTimeoutMs: manifest.callTimeoutMs,
      firstTokenTimeoutMs: manifest.firstTokenTimeoutMs,
      idleTimeoutMs: manifest.idleTimeoutMs,
      loopDetectionThreshold: manifest.loopDetectionThreshold,
      runtimeTimeoutMs: timeoutMs,
    }),
    requireToolUse: output.requiredWork.required,
    profile: resolveLoopProfile(manifest),
    authorizedToolNames,
  };
}
