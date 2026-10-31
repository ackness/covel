import { createHash } from "node:crypto";
import { estimateMessageTokens, type TokenEstimator } from "@covel/context";
import { instructionLocaleFor, type LLMMessage } from "@covel/shared";
import { z } from "zod";
import {
  loopStepDigestMessage,
  type LoopStepDigest,
} from "./loop-step-digest.js";

interface StepGroup {
  readonly start: number;
  readonly end: number;
  readonly assistant: LLMMessage;
  readonly results: readonly LLMMessage[];
  readonly ids: readonly string[];
  readonly key: string;
}

/** Only complete, contiguous call/result groups in provider order are eligible. */
function stepGroups(messages: readonly LLMMessage[]): StepGroup[] {
  const groups: StepGroup[] = [];
  for (let start = 0; start < messages.length; start += 1) {
    const assistant = messages[start]!;
    const calls =
      assistant.role === "assistant" ? assistant.toolCalls : undefined;
    if (!calls?.length) continue;
    const ids = calls.map((call) => call.id);
    const results = messages.slice(start + 1, start + 1 + calls.length);
    if (
      new Set(ids).size !== ids.length ||
      results.length !== calls.length ||
      !results.every(
        (result, index) =>
          result.role === "tool" && result.toolCallId === ids[index],
      ) ||
      messages[start + 1 + calls.length]?.role === "tool"
    )
      continue;
    groups.push({
      start,
      end: start + 1 + calls.length,
      assistant,
      results,
      ids,
      // Filtering can renumber reused IDs. Verify call metadata and result
      // content instead, without retaining full tool data in the ledger.
      key: createHash("sha256")
        .update(
          JSON.stringify([
            calls.map((call) => [call.id, call.name, call.arguments]),
            results.map((result) => [result.name, result.content]),
          ]),
        )
        .digest("hex"),
    });
    start += calls.length;
  }
  return groups;
}

export function hasToolStepGroup(messages: readonly LLMMessage[]): boolean {
  return stepGroups(messages).length > 0;
}

const objectSchema = z.record(z.string(), z.unknown());
function parseObject(
  content: LLMMessage["content"],
): Record<string, unknown> | undefined {
  if (typeof content !== "string") return undefined;
  try {
    const parsed = objectSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function preview(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

interface CollapseEntry {
  readonly groups: readonly string[];
  readonly digest: LoopStepDigest;
}

export interface LoopContextPolicy {
  fit(
    messages: readonly LLMMessage[],
    ctx: {
      readonly inputLimit: number;
      readonly fixedTokens: number;
      readonly estimator: TokenEstimator;
      readonly mode: "normal" | "emergency";
    },
  ): {
    readonly messages: LLMMessage[];
    readonly elidedToolResultCount: number;
    readonly collapsedStepCount: number;
  };
}

/** A request-only, append-only ledger. It retains strings and hashes, never messages. */
export function createLoopContextPolicy(options: {
  locale?: string;
}): LoopContextPolicy {
  const zh = instructionLocaleFor(options.locale) === "zh";
  const marker = zh ? "[较早的工具输出已省略]" : "[older tool output omitted]";
  const header = zh
    ? "[本次运行较早的工具步骤，已压缩。其输出不再显示；需要数据时请重新调用工具。]"
    : "[Earlier tool steps of this run, condensed. Their output is no longer shown; call a tool again if you need the data.]";
  const elided = new Map<string, string>();
  const collapsed: CollapseEntry[] = [];

  return {
    fit(messages, ctx) {
      const groups = stepGroups(messages);
      const groupsByKey = new Map<string, StepGroup[]>();
      for (const group of groups) {
        const matches = groupsByKey.get(group.key) ?? [];
        matches.push(group);
        groupsByKey.set(group.key, matches);
      }
      const resultKeys = new Map<number, string>();
      for (const group of groups) {
        // Identical groups cannot be distinguished after a hook filters them.
        if (groupsByKey.get(group.key)!.length !== 1) continue;
        for (const index of group.results.keys())
          resultKeys.set(group.start + 1 + index, `${group.key}:${index}`);
      }
      const applied = new Set<StepGroup>();
      const replacements = new Map<number, LoopStepDigest>();
      const removed = new Set<number>();
      let collapsedStepCount = 0;
      const applyEntry = (entry: CollapseEntry) => {
        const matches = entry.groups.map((key) => groupsByKey.get(key) ?? []);
        // A hook may remove or reshape a group; skip an incomplete frozen event.
        if (
          matches.some((found) => found.length !== 1 || applied.has(found[0]!))
        )
          return;
        const selected = matches.map((found) => found[0]!);
        replacements.set(selected[0]!.start, entry.digest);
        for (const group of selected) {
          applied.add(group);
          for (let index = group.start; index < group.end; index += 1)
            removed.add(index);
        }
        collapsedStepCount += selected.length;
      };
      for (const entry of collapsed) applyEntry(entry);

      const render = (pending?: {
        groups: readonly StepGroup[];
        digest: LoopStepDigest;
      }): LLMMessage[] => {
        const pendingRemoved = new Set<number>();
        for (const group of pending?.groups ?? []) {
          for (let index = group.start; index < group.end; index += 1)
            pendingRemoved.add(index);
        }
        const output: LLMMessage[] = [];
        for (const [index, message] of messages.entries()) {
          const digest = replacements.get(index);
          if (digest !== undefined) output.push(loopStepDigestMessage(digest));
          if (index === pending?.groups[0]?.start)
            output.push(loopStepDigestMessage(pending.digest));
          if (removed.has(index) || pendingRemoved.has(index)) continue;
          const key = resultKeys.get(index);
          const body =
            typeof message.content === "string" && key !== undefined
              ? elided.get(key)
              : undefined;
          output.push(
            body !== undefined ? { ...message, content: body } : message,
          );
        }
        return output;
      };
      const total = (request: readonly LLMMessage[]) =>
        ctx.fixedTokens +
        request.reduce(
          (sum, message) => sum + estimateMessageTokens(message, ctx.estimator),
          0,
        );
      let request = render();
      const emergency = ctx.mode === "emergency";
      if (total(request) > ctx.inputLimit) {
        const target = Math.floor(0.7 * ctx.inputLimit);
        const available = groups.filter((group) => !applied.has(group));
        const elidable = emergency ? available : available.slice(0, -2);
        for (const group of elidable) {
          if (total(request) <= target) break;
          for (const [index, result] of group.results.entries()) {
            const key = resultKeys.get(group.start + 1 + index);
            if (
              key === undefined ||
              typeof result.content !== "string" ||
              elided.has(key)
            )
              continue;
            const envelope = parseObject(result.content);
            const content =
              result.content === marker || envelope?.data === marker
                ? result.content
                : envelope && Object.hasOwn(envelope, "data")
                  ? JSON.stringify({ ...envelope, data: marker })
                  : marker;
            elided.set(key, content);
          }
          request = render();
        }

        const collapsible = emergency ? available : available.slice(0, -1);
        const selected: StepGroup[] = [];
        const steps: LoopStepDigest["steps"][number][] = [];
        // Do not let identifiers from arguments or summaries leak into the digest.
        const ids = groups.flatMap((group) => group.ids);
        const clean = (text: string) => {
          let result = text;
          for (const id of ids)
            if (id) result = result.replaceAll(id, "[omitted]");
          return result
            .replace(
              /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
              "[omitted]",
            )
            .replace(
              /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g,
              "[omitted]",
            )
            .replace(/[\r\n]+/g, " ");
        };
        for (const group of collapsible) {
          if (total(request) <= target) break;
          if (groupsByKey.get(group.key)!.length !== 1) continue;
          selected.push(group);
          for (const [index, call] of group.assistant.toolCalls!.entries()) {
            const envelope = parseObject(group.results[index]!.content);
            const error = objectSchema.safeParse(envelope?.error);
            const outcome =
              error.success && typeof error.data.code === "string"
                ? `failed: ${clean(error.data.code)}`
                : typeof envelope?.summary === "string"
                  ? `ok: ${preview(clean(envelope.summary), 80)}`
                  : "ok";
            steps.push({
              callId: call.id,
              text: `- ${clean(call.name)}(${preview(clean(JSON.stringify(call.arguments)), 120)}) -> ${outcome}`,
            });
          }
          request = render({
            groups: selected,
            digest: { header, steps: [...steps] },
          });
        }
        if (selected.length > 0) {
          collapsed.push({
            groups: selected.map((group) => group.key),
            digest: { header, steps: [...steps] },
          });
          collapsedStepCount += selected.length;
        }
      }
      const appliedElisions = [...resultKeys].filter(
        ([index, key]) =>
          typeof messages[index]!.content === "string" && elided.has(key),
      ).length;
      return {
        messages: request,
        elidedToolResultCount: appliedElisions,
        collapsedStepCount,
      };
    },
  };
}
