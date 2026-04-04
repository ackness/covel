/**
 * Pure business logic for notification management.
 * All functions are immutable — they return new state objects.
 */

export type NotificationLevel = "info" | "warning" | "success" | "error";

export interface Notification {
  readonly id: string;
  readonly level: NotificationLevel;
  readonly title: string;
  readonly content?: string;
  readonly source?: string;
  readonly turnId?: number;
  readonly createdAt: string;
  readonly read: boolean;
}

export interface NotificationState {
  readonly notifications: readonly Notification[];
}

export const EMPTY_STATE: NotificationState = { notifications: [] };

export interface AddNotificationParams {
  readonly level: NotificationLevel;
  readonly title: string;
  readonly content?: string;
  readonly source?: string;
  readonly turnId?: number;
}

export interface AddNotificationResult {
  readonly state: NotificationState;
  readonly notification: Notification;
}

/**
 * Add a new notification to the state.
 * Returns a new state with the notification appended.
 */
export function addNotification(
  state: NotificationState,
  params: AddNotificationParams,
  generateId: () => string = () => crypto.randomUUID(),
): AddNotificationResult {
  const notification: Notification = {
    id: generateId(),
    level: params.level,
    title: params.title,
    content: params.content,
    source: params.source,
    turnId: params.turnId,
    createdAt: new Date().toISOString(),
    read: false,
  };

  const newState: NotificationState = {
    notifications: [...state.notifications, notification],
  };

  return { state: newState, notification };
}

/**
 * Mark a specific notification as read by its ID.
 * Returns a new state; if the ID is not found, returns the original state unchanged.
 */
export function markAsRead(
  state: NotificationState,
  notificationId: string,
): NotificationState {
  const idx = state.notifications.findIndex((n) => n.id === notificationId);
  if (idx === -1) {
    return state;
  }

  const updated: Notification = { ...state.notifications[idx], read: true };
  const newNotifications = state.notifications.map((n, i) =>
    i === idx ? updated : n,
  );

  return { notifications: newNotifications };
}

/**
 * Mark all notifications as read.
 * Returns a new state with all notifications having read: true.
 */
export function markAllAsRead(state: NotificationState): NotificationState {
  if (state.notifications.length === 0) {
    return state;
  }

  return {
    notifications: state.notifications.map((n) => ({ ...n, read: true })),
  };
}

/**
 * Return the count of unread notifications.
 */
export function getUnreadCount(state: NotificationState): number {
  return state.notifications.filter((n) => !n.read).length;
}

/**
 * Return all notifications filtered by level.
 */
export function getNotificationsByLevel(
  state: NotificationState,
  level: NotificationLevel,
): readonly Notification[] {
  return state.notifications.filter((n) => n.level === level);
}

/**
 * Return recent notifications sorted by createdAt descending.
 * Defaults to the 20 most recent.
 */
export function getRecentNotifications(
  state: NotificationState,
  limit = 20,
): readonly Notification[] {
  return [...state.notifications]
    .map((n, index) => ({ n, index }))
    .sort((a, b) => {
      const timeDiff = b.n.createdAt.localeCompare(a.n.createdAt);
      if (timeDiff !== 0) return timeDiff;
      // Stable tiebreaker: later-appended (higher index) notifications are "more recent"
      return b.index - a.index;
    })
    .map(({ n }) => n)
    .slice(0, limit);
}

/**
 * Build a human-readable summary of unread notifications for context injection.
 */
export function getNotificationSummary(
  state: NotificationState,
  locale: string,
): string {
  const isZh = locale.startsWith("zh");
  const unread = state.notifications.filter((n) => !n.read);

  if (unread.length === 0) {
    return isZh ? "暂无未读通知。" : "No unread notifications.";
  }

  const levelLabels: Record<NotificationLevel, { zh: string; en: string }> = {
    info: { zh: "信息", en: "info" },
    warning: { zh: "警告", en: "warning" },
    success: { zh: "成功", en: "success" },
    error: { zh: "错误", en: "error" },
  };

  const lines: string[] = [];
  for (const n of unread) {
    const levelLabel = isZh
      ? levelLabels[n.level].zh
      : levelLabels[n.level].en;
    const contentPart = n.content ? `: ${n.content}` : "";
    lines.push(`[${levelLabel}] **${n.title}**${contentPart}`);
  }

  return lines.join("\n");
}
