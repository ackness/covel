import type { ToolExecutionContext, ToolExecutionResult } from "@covel/shared";
import type { MemoryArchive } from "./logic.js";

/**
 * Update the rolling memory archive with a new summary.
 * Increments the version and stores the turnId for reference.
 */
export async function updateMemoryArchiveTool(
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const input = ctx.input as { summary: string };
  const summary = input.summary?.trim();

  if (!summary) {
    return {
      output: {
        error: isZh ? "摘要内容不能为空。" : "Summary content is required.",
      },
    };
  }

  const state = ctx.state as Record<string, unknown> | undefined;
  const existing = state?.memoryArchive as MemoryArchive | undefined;
  const currentVersion = existing?.version ?? 0;
  const nextVersion = currentVersion + 1;
  const turnId = (state?.turnId as string) ?? "unknown";

  const archive: MemoryArchive = {
    summary,
    version: nextVersion,
    lastTurnId: turnId,
  };

  return {
    output: {
      message: isZh
        ? `记忆档案已更新至 v${nextVersion}。`
        : `Memory archive updated to v${nextVersion}.`,
      version: nextVersion,
    },
    proposals: [
      {
        kind: "state.patch",
        payload: { memoryArchive: archive },
      },
    ],
  };
}

/**
 * Record an individual key event for long-term storage.
 */
export async function recordKeyEventTool(
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const input = ctx.input as { content: string };
  const content = input.content?.trim();

  if (!content) {
    return {
      output: {
        error: isZh ? "事件内容不能为空。" : "Event content is required.",
      },
    };
  }

  const state = ctx.state as Record<string, unknown> | undefined;
  const turnId = (state?.turnId as string) ?? "unknown";
  const key = `memory:event:${turnId}:${Date.now()}`;

  return {
    output: {
      message: isZh
        ? `已记录关键事件。`
        : `Key event recorded.`,
    },
    proposals: [
      {
        kind: "record.upsert",
        payload: {
          key,
          value: {
            recordType: "memory.key_event",
            content,
            turnId,
          },
        },
      },
    ],
  };
}
