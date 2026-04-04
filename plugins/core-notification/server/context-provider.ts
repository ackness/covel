import type { ContextProviderInput } from "@covel/plugin-runtime";
import {
  getUnreadCount,
  getNotificationSummary,
  EMPTY_STATE,
  type NotificationState,
} from "./notification-logic.js";

/**
 * Context provider that injects unread notification summaries into the runtime context.
 * Returns null when there are no unread notifications (no context injection needed).
 */
export async function notificationContextProvider(
  input: ContextProviderInput,
): Promise<unknown> {
  const isZh = input.locale.startsWith("zh");
  const state = input.state as Record<string, unknown> | undefined;
  const notificationState =
    (state?.["core-notification"] as NotificationState) ?? EMPTY_STATE;

  const unreadCount = getUnreadCount(notificationState);
  if (unreadCount === 0) {
    return null;
  }

  const summary = getNotificationSummary(notificationState, input.locale);

  return {
    id: "notification-context",
    title: isZh ? "未读通知" : "Unread Notifications",
    content: summary,
    priority: 30,
  };
}
