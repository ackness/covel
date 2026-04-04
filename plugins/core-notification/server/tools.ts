import type { ToolExecutionContext, ToolExecutionResult } from "@covel/shared";
import { z } from "zod";
import {
  addNotification,
  EMPTY_STATE,
  type NotificationState,
} from "./notification-logic.js";

// ── Zod Schema ────────────────────────────────────────────────

const emitNotificationInputSchema = z.object({
  level: z.enum(["info", "warning", "success", "error"]),
  title: z.string().min(1),
  content: z.string().optional(),
  source: z.string().optional(),
});

// ── Helpers ───────────────────────────────────────────────────

function extractNotificationState(
  state: Record<string, unknown> | undefined,
): NotificationState {
  if (state && typeof state === "object") {
    const pluginState = state["core-notification"];
    if (
      pluginState &&
      typeof pluginState === "object" &&
      Array.isArray(
        (pluginState as Record<string, unknown>).notifications,
      )
    ) {
      return pluginState as unknown as NotificationState;
    }
  }
  return EMPTY_STATE;
}

/**
 * Tool: emit-notification
 *
 * Emits a structured notification that appears in the UI and is stored in state.
 */
export async function emitNotificationTool(
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");

  const parsed = emitNotificationInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }

  const input = parsed.data;
  const currentState = extractNotificationState(ctx.state);

  const { state: newState, notification } = addNotification(currentState, {
    level: input.level,
    title: input.title,
    content: input.content,
    source: input.source,
  });

  return {
    output: {
      message: isZh
        ? `已创建通知「${notification.title}」(${notification.id})。`
        : `Notification "${notification.title}" (${notification.id}) created.`,
    },
    proposals: [
      {
        kind: "state.patch",
        payload: {
          scope: "core-notification",
          patch: { notifications: newState.notifications },
        },
      },
      {
        kind: "ui.render",
        payload: {
          blockType: "notification",
          data: {
            level: notification.level,
            title: notification.title,
            content: notification.content,
            source: notification.source,
          },
        },
      },
    ],
  };
}
