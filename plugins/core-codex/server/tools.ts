import type { ToolExecutionContext, ToolExecutionResult } from "@covel/shared";
import { z } from "zod";
import {
  unlockEntry,
  updateEntry,
  EMPTY_STATE,
  type CodexState,
} from "./codex-logic.js";

// ── Zod Schemas ─────────────────────────────────────────────────

const unlockCodexEntryInputSchema = z.object({
  category: z.enum(["monster", "item", "location", "lore", "character"]),
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  imageHint: z.string().optional(),
});

const updateCodexEntryInputSchema = z.object({
  entryId: z.string(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  imageHint: z.string().optional(),
});

// ── Helpers ───────────────────────────────────────────────────────

function extractCodexState(state: Record<string, unknown> | undefined): CodexState {
  if (state && typeof state === "object") {
    const codexState = state["core-codex"];
    if (codexState && typeof codexState === "object" && Array.isArray((codexState as Record<string, unknown>).entries)) {
      return codexState as unknown as CodexState;
    }
  }
  return EMPTY_STATE;
}

/**
 * Tool: unlock-codex-entry
 *
 * Creates a new codex entry when new knowledge is discovered.
 * The LLM provides all entry data; the tool generates an ID and emits proposals.
 */
export async function unlockCodexEntryTool(
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const parsed = unlockCodexEntryInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }
  const input = parsed.data;

  const currentState = extractCodexState(ctx.state);

  try {
    const result = unlockEntry(currentState, {
      category: input.category,
      title: input.title,
      content: input.content,
      tags: input.tags,
      imageHint: input.imageHint,
    });

    return {
      output: {
        message: isZh
          ? `已解锁图鉴条目「${result.entry.title}」(${result.entry.entryId})，分类：${result.entry.category}。`
          : `Unlocked codex entry "${result.entry.title}" (${result.entry.entryId}), category: ${result.entry.category}.`,
        entryId: result.entry.entryId,
      },
      proposals: [
        {
          kind: "state.patch",
          payload: {
            scope: "core-codex",
            patch: { entries: result.state.entries },
          },
        },
        {
          kind: "record.upsert",
          payload: {
            key: `codex:${result.entry.entryId}`,
            recordType: "codex",
            value: result.entry,
          },
        },
        {
          kind: "event.emit",
          payload: {
            type: "codex_unlocked",
            entryId: result.entry.entryId,
            title: result.entry.title,
            category: result.entry.category,
          },
        },
        {
          kind: "ui.render",
          payload: {
            blockType: "codex_entry",
            data: {
              action: "unlock",
              category: result.entry.category,
              entryId: result.entry.entryId,
              title: result.entry.title,
              content: result.entry.content,
              tags: [...result.entry.tags],
            },
          },
        },
      ],
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return { output: { error: msg } };
  }
}

/**
 * Tool: update-codex-entry
 *
 * Updates an existing codex entry when knowledge is expanded or corrected.
 */
export async function updateCodexEntryTool(
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const parsed = updateCodexEntryInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }
  const input = parsed.data;

  const currentState = extractCodexState(ctx.state);

  try {
    const updates: Parameters<typeof updateEntry>[2] = {};
    if (input.content !== undefined) updates.content = input.content;
    if (input.tags !== undefined) updates.tags = input.tags;
    if (input.imageHint !== undefined) updates.imageHint = input.imageHint;

    const newState = updateEntry(currentState, input.entryId, updates);

    const updatedEntry = newState.entries.find(
      (e) => e.entryId === input.entryId,
    );

    if (!updatedEntry) {
      return {
        output: { error: `Entry not found after update: ${input.entryId}` },
      };
    }

    return {
      output: {
        message: isZh
          ? `已更新图鉴条目 ${input.entryId}。`
          : `Updated codex entry ${input.entryId}.`,
      },
      proposals: [
        {
          kind: "state.patch",
          payload: {
            scope: "core-codex",
            patch: { entries: newState.entries },
          },
        },
        {
          kind: "record.upsert",
          payload: {
            key: `codex:${input.entryId}`,
            recordType: "codex",
            value: updatedEntry,
          },
        },
        {
          kind: "ui.render",
          payload: {
            blockType: "codex_entry",
            data: {
              action: "update",
              category: updatedEntry?.category,
              entryId: input.entryId,
              title: updatedEntry?.title,
              content: updatedEntry?.content,
              tags: updatedEntry ? [...updatedEntry.tags] : [],
            },
          },
        },
      ],
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return { output: { error: msg } };
  }
}
