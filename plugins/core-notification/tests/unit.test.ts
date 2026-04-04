import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { validateManifest } from "@covel/plugin-runtime";
import {
  addNotification,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  getNotificationsByLevel,
  getRecentNotifications,
  getNotificationSummary,
  EMPTY_STATE,
  type NotificationLevel,
  type NotificationState,
} from "../server/notification-logic.js";
import { emitNotificationTool } from "../server/tools.js";
import { notificationContextProvider } from "../server/context-provider.js";
import type { ToolExecutionContext } from "@covel/shared";

// ── plugin.json manifest ────────────────────────────────────────

describe("plugin.json manifest", () => {
  it("passes schema validation", () => {
    const raw = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../plugin.json"), "utf-8"),
    );
    const result = validateManifest(raw);
    if (!result.ok) {
      throw new Error(
        `Manifest validation failed:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }
    expect(result.ok).toBe(true);
  });
});

// ── Helpers ──────────────────────────────────────────────────

let idCounter = 0;
function deterministicId(): string {
  idCounter += 1;
  return `notif-test-${idCounter}`;
}

function resetIds(): void {
  idCounter = 0;
}

function makeToolCtx(
  input: unknown,
  locale = "en-US",
  state?: Record<string, unknown>,
): ToolExecutionContext {
  return {
    input,
    runtimeId: "notification-background",
    pluginId: "core-notification",
    locale,
    state,
  };
}

// ── notification-logic unit tests ──────────────────────────

describe("notification-logic", () => {
  describe("addNotification", () => {
    it("creates a new notification with provided fields", () => {
      resetIds();
      const { state, notification } = addNotification(
        EMPTY_STATE,
        {
          level: "info",
          title: "Quest Started",
          content: "You have begun a new quest.",
          source: "core-quest",
        },
        deterministicId,
      );

      expect(notification.id).toBe("notif-test-1");
      expect(notification.level).toBe("info");
      expect(notification.title).toBe("Quest Started");
      expect(notification.content).toBe("You have begun a new quest.");
      expect(notification.source).toBe("core-quest");
      expect(notification.createdAt).toBeDefined();
      expect(notification.read).toBe(false);

      expect(state.notifications).toHaveLength(1);
      expect(state.notifications[0]).toEqual(notification);
    });

    it("creates notification without optional fields", () => {
      resetIds();
      const { notification } = addNotification(
        EMPTY_STATE,
        { level: "warning", title: "Danger Ahead" },
        deterministicId,
      );

      expect(notification.content).toBeUndefined();
      expect(notification.source).toBeUndefined();
      expect(notification.turnId).toBeUndefined();
    });

    it("appends notification without mutating original state", () => {
      resetIds();
      const { state: s1 } = addNotification(
        EMPTY_STATE,
        { level: "info", title: "First" },
        deterministicId,
      );

      const { state: s2 } = addNotification(
        s1,
        { level: "success", title: "Second" },
        deterministicId,
      );

      expect(EMPTY_STATE.notifications).toHaveLength(0);
      expect(s1.notifications).toHaveLength(1);
      expect(s2.notifications).toHaveLength(2);
    });

    it("new notifications are unread by default", () => {
      resetIds();
      const { notification } = addNotification(
        EMPTY_STATE,
        { level: "error", title: "System Failure" },
        deterministicId,
      );

      expect(notification.read).toBe(false);
    });

    it("supports turnId field", () => {
      resetIds();
      const { notification } = addNotification(
        EMPTY_STATE,
        { level: "info", title: "Turn Event", turnId: 5 },
        deterministicId,
      );

      expect(notification.turnId).toBe(5);
    });
  });

  describe("markAsRead", () => {
    it("marks a notification as read", () => {
      resetIds();
      const { state: s1 } = addNotification(
        EMPTY_STATE,
        { level: "info", title: "Test Notification" },
        deterministicId,
      );

      const s2 = markAsRead(s1, "notif-test-1");

      expect(s2.notifications[0].read).toBe(true);
    });

    it("does not mutate original state", () => {
      resetIds();
      const { state: s1 } = addNotification(
        EMPTY_STATE,
        { level: "info", title: "Test" },
        deterministicId,
      );

      const s2 = markAsRead(s1, "notif-test-1");

      expect(s1.notifications[0].read).toBe(false);
      expect(s2.notifications[0].read).toBe(true);
    });

    it("returns same state if notification not found", () => {
      resetIds();
      const { state: s1 } = addNotification(
        EMPTY_STATE,
        { level: "info", title: "Test" },
        deterministicId,
      );

      const s2 = markAsRead(s1, "nonexistent-id");

      expect(s2.notifications).toHaveLength(1);
      expect(s2.notifications[0].read).toBe(false);
    });

    it("only marks the targeted notification as read", () => {
      resetIds();
      const { state: s1 } = addNotification(
        EMPTY_STATE,
        { level: "info", title: "First" },
        deterministicId,
      );
      const { state: s2 } = addNotification(
        s1,
        { level: "warning", title: "Second" },
        deterministicId,
      );

      const s3 = markAsRead(s2, "notif-test-1");

      expect(s3.notifications[0].read).toBe(true);
      expect(s3.notifications[1].read).toBe(false);
    });
  });

  describe("markAllAsRead", () => {
    it("marks all notifications as read", () => {
      resetIds();
      const { state: s1 } = addNotification(
        EMPTY_STATE,
        { level: "info", title: "First" },
        deterministicId,
      );
      const { state: s2 } = addNotification(
        s1,
        { level: "warning", title: "Second" },
        deterministicId,
      );
      const { state: s3 } = addNotification(
        s2,
        { level: "error", title: "Third" },
        deterministicId,
      );

      const s4 = markAllAsRead(s3);

      expect(s4.notifications.every((n) => n.read)).toBe(true);
    });

    it("does not mutate original state", () => {
      resetIds();
      const { state: s1 } = addNotification(
        EMPTY_STATE,
        { level: "info", title: "Test" },
        deterministicId,
      );

      const s2 = markAllAsRead(s1);

      expect(s1.notifications[0].read).toBe(false);
      expect(s2.notifications[0].read).toBe(true);
    });

    it("returns empty notifications array for empty state", () => {
      const s = markAllAsRead(EMPTY_STATE);
      expect(s.notifications).toHaveLength(0);
    });
  });

  describe("getUnreadCount", () => {
    it("returns 0 for empty state", () => {
      expect(getUnreadCount(EMPTY_STATE)).toBe(0);
    });

    it("returns count of unread notifications", () => {
      resetIds();
      const { state: s1 } = addNotification(
        EMPTY_STATE,
        { level: "info", title: "First" },
        deterministicId,
      );
      const { state: s2 } = addNotification(
        s1,
        { level: "warning", title: "Second" },
        deterministicId,
      );

      expect(getUnreadCount(s2)).toBe(2);
    });

    it("excludes read notifications from count", () => {
      resetIds();
      const { state: s1 } = addNotification(
        EMPTY_STATE,
        { level: "info", title: "First" },
        deterministicId,
      );
      const { state: s2 } = addNotification(
        s1,
        { level: "warning", title: "Second" },
        deterministicId,
      );

      const s3 = markAsRead(s2, "notif-test-1");

      expect(getUnreadCount(s3)).toBe(1);
    });
  });

  describe("getNotificationsByLevel", () => {
    it("returns notifications filtered by level", () => {
      resetIds();
      const { state: s1 } = addNotification(
        EMPTY_STATE,
        { level: "info", title: "Info 1" },
        deterministicId,
      );
      const { state: s2 } = addNotification(
        s1,
        { level: "warning", title: "Warning 1" },
        deterministicId,
      );
      const { state: s3 } = addNotification(
        s2,
        { level: "info", title: "Info 2" },
        deterministicId,
      );

      const infos = getNotificationsByLevel(s3, "info");
      expect(infos).toHaveLength(2);
      expect(infos[0].title).toBe("Info 1");
      expect(infos[1].title).toBe("Info 2");
    });

    it("returns empty array when no notifications match level", () => {
      expect(getNotificationsByLevel(EMPTY_STATE, "error")).toHaveLength(0);
    });

    it("filters by success level", () => {
      resetIds();
      const { state: s1 } = addNotification(
        EMPTY_STATE,
        { level: "success", title: "Achievement!" },
        deterministicId,
      );
      const { state: s2 } = addNotification(
        s1,
        { level: "error", title: "Error!" },
        deterministicId,
      );

      const successes = getNotificationsByLevel(s2, "success");
      expect(successes).toHaveLength(1);
      expect(successes[0].title).toBe("Achievement!");
    });
  });

  describe("getRecentNotifications", () => {
    it("returns all notifications sorted by createdAt descending", () => {
      resetIds();
      const { state: s1 } = addNotification(
        EMPTY_STATE,
        { level: "info", title: "First" },
        deterministicId,
      );
      const { state: s2 } = addNotification(
        s1,
        { level: "warning", title: "Second" },
        deterministicId,
      );
      const { state: s3 } = addNotification(
        s2,
        { level: "success", title: "Third" },
        deterministicId,
      );

      const recent = getRecentNotifications(s3);
      // Most recent first
      expect(recent[0].title).toBe("Third");
      expect(recent[1].title).toBe("Second");
      expect(recent[2].title).toBe("First");
    });

    it("limits results to given limit parameter", () => {
      resetIds();
      let state: NotificationState = EMPTY_STATE;
      for (let i = 0; i < 25; i++) {
        const result = addNotification(
          state,
          { level: "info", title: `Notification ${i + 1}` },
          deterministicId,
        );
        state = result.state;
      }

      const recent = getRecentNotifications(state, 5);
      expect(recent).toHaveLength(5);
    });

    it("uses default limit of 20", () => {
      resetIds();
      let state: NotificationState = EMPTY_STATE;
      for (let i = 0; i < 25; i++) {
        const result = addNotification(
          state,
          { level: "info", title: `Notification ${i + 1}` },
          deterministicId,
        );
        state = result.state;
      }

      const recent = getRecentNotifications(state);
      expect(recent).toHaveLength(20);
    });

    it("returns all notifications when fewer than limit", () => {
      resetIds();
      const { state: s1 } = addNotification(
        EMPTY_STATE,
        { level: "info", title: "Only One" },
        deterministicId,
      );

      const recent = getRecentNotifications(s1, 10);
      expect(recent).toHaveLength(1);
    });

    it("returns empty array for empty state", () => {
      expect(getRecentNotifications(EMPTY_STATE)).toHaveLength(0);
    });
  });

  describe("getNotificationSummary", () => {
    it("returns empty-state message in English", () => {
      const summary = getNotificationSummary(EMPTY_STATE, "en-US");
      expect(summary).toBe("No unread notifications.");
    });

    it("returns empty-state message in Chinese", () => {
      const summary = getNotificationSummary(EMPTY_STATE, "zh-CN");
      expect(summary).toBe("暂无未读通知。");
    });

    it("summarizes unread notifications in English", () => {
      resetIds();
      const { state: s1 } = addNotification(
        EMPTY_STATE,
        { level: "warning", title: "Low Health", content: "Your HP is low." },
        deterministicId,
      );
      const { state: s2 } = addNotification(
        s1,
        { level: "success", title: "Quest Complete" },
        deterministicId,
      );

      const summary = getNotificationSummary(s2, "en-US");
      expect(summary).toContain("Low Health");
      expect(summary).toContain("Quest Complete");
      expect(summary).toContain("warning");
      expect(summary).toContain("success");
    });

    it("does not include read notifications", () => {
      resetIds();
      const { state: s1 } = addNotification(
        EMPTY_STATE,
        { level: "info", title: "Read Notification" },
        deterministicId,
      );
      const { state: s2 } = addNotification(
        s1,
        { level: "warning", title: "Unread Notification" },
        deterministicId,
      );

      const s3 = markAsRead(s2, "notif-test-1");
      const summary = getNotificationSummary(s3, "en-US");

      expect(summary).not.toContain("Read Notification");
      expect(summary).toContain("Unread Notification");
    });
  });
});

// ── Tool wrapper tests ──────────────────────────────────────

describe("tools", () => {
  describe("emitNotificationTool", () => {
    it("returns state.patch and ui.render proposals on valid input", async () => {
      const result = await emitNotificationTool(
        makeToolCtx({
          level: "info",
          title: "Quest Started",
          content: "You have begun a new quest.",
          source: "core-quest",
        }),
      );

      expect(result.proposals).toHaveLength(2);

      const kinds = result.proposals!.map((p) => p.kind);
      expect(kinds).toContain("state.patch");
      expect(kinds).toContain("ui.render");
    });

    it("returns success message in English", async () => {
      const result = await emitNotificationTool(
        makeToolCtx({
          level: "success",
          title: "Achievement Unlocked",
        }),
      );

      const output = result.output as Record<string, unknown>;
      const msg = output.message as string;
      expect(msg).toContain("Achievement Unlocked");
    });

    it("returns bilingual message in Chinese locale", async () => {
      const result = await emitNotificationTool(
        makeToolCtx(
          {
            level: "warning",
            title: "危险前方",
            content: "前方有强大的敌人。",
          },
          "zh-CN",
        ),
      );

      const output = result.output as Record<string, unknown>;
      const msg = output.message as string;
      expect(msg).toContain("危险前方");
      expect(msg).toMatch(/通知|已发|已创建/);
    });

    it("includes correct level in state.patch", async () => {
      const result = await emitNotificationTool(
        makeToolCtx({
          level: "error",
          title: "Critical Error",
        }),
      );

      const patch = result.proposals!.find((p) => p.kind === "state.patch");
      const payload = patch?.payload as Record<string, unknown>;
      expect(payload.scope).toBe("core-notification");

      const patchData = payload.patch as Record<string, unknown>;
      const notifications = patchData.notifications as Array<Record<string, unknown>>;
      expect(notifications[0].level).toBe("error");
      expect(notifications[0].title).toBe("Critical Error");
    });

    it("includes ui.render with notification block type", async () => {
      const result = await emitNotificationTool(
        makeToolCtx({
          level: "success",
          title: "Level Up!",
          content: "You reached level 10.",
          source: "core-combat",
        }),
      );

      const uiBlock = result.proposals!.find((p) => p.kind === "ui.render");
      const payload = uiBlock?.payload as Record<string, unknown>;
      expect(payload.blockType).toBe("notification");

      const data = payload.data as Record<string, unknown>;
      expect(data.level).toBe("success");
      expect(data.title).toBe("Level Up!");
      expect(data.content).toBe("You reached level 10.");
      expect(data.source).toBe("core-combat");
    });

    it("works without optional content and source fields", async () => {
      const result = await emitNotificationTool(
        makeToolCtx({
          level: "info",
          title: "System Message",
        }),
      );

      expect(result.proposals).toHaveLength(2);

      const output = result.output as Record<string, unknown>;
      expect(output.message).toBeDefined();
    });

    it("returns error for invalid level", async () => {
      const result = await emitNotificationTool(
        makeToolCtx({ level: "critical", title: "Test" }),
      );

      const output = result.output as Record<string, unknown>;
      expect(output).toHaveProperty("error");
      expect(result.proposals).toBeUndefined();
    });

    it("returns error for missing title", async () => {
      const result = await emitNotificationTool(
        makeToolCtx({ level: "info" }),
      );

      const output = result.output as Record<string, unknown>;
      expect(output).toHaveProperty("error");
    });

    it("returns error for empty title", async () => {
      const result = await emitNotificationTool(
        makeToolCtx({ level: "info", title: "" }),
      );

      const output = result.output as Record<string, unknown>;
      expect(output).toHaveProperty("error");
    });

    it("appends to existing state when state is provided", async () => {
      // Emit first notification
      const first = await emitNotificationTool(
        makeToolCtx({ level: "info", title: "First" }),
      );

      const firstPatch = first.proposals!.find(
        (p) => p.kind === "state.patch",
      )?.payload as Record<string, unknown>;
      const firstStatePatch = firstPatch.patch as Record<string, unknown>;

      // Emit second notification with existing state
      const second = await emitNotificationTool(
        makeToolCtx(
          { level: "warning", title: "Second" },
          "en-US",
          { "core-notification": firstStatePatch },
        ),
      );

      const secondPatch = second.proposals!.find(
        (p) => p.kind === "state.patch",
      )?.payload as Record<string, unknown>;
      const secondStatePatch = secondPatch.patch as Record<string, unknown>;
      const notifications = secondStatePatch.notifications as unknown[];
      expect(notifications).toHaveLength(2);
    });
  });
});

// ── Context provider tests ──────────────────────────────────

describe("notificationContextProvider", () => {
  it("returns null/undefined when no unread notifications", async () => {
    const result = await notificationContextProvider({
      pluginId: "core-notification",
      runtimeId: "notification-background",
      locale: "en-US",
      state: {},
    });

    expect(result).toBeNull();
  });

  it("returns context when there are unread notifications", async () => {
    resetIds();
    const { state } = addNotification(
      EMPTY_STATE,
      {
        level: "warning",
        title: "Low Health",
        content: "Your HP is critically low.",
      },
      deterministicId,
    );

    const result = (await notificationContextProvider({
      pluginId: "core-notification",
      runtimeId: "notification-background",
      locale: "en-US",
      state: { "core-notification": state },
    })) as Record<string, unknown>;

    expect(result).not.toBeNull();
    expect(result.content as string).toContain("Low Health");
    expect(result.priority).toBe(30);
  });

  it("returns null after all notifications are read", async () => {
    resetIds();
    const { state: s1 } = addNotification(
      EMPTY_STATE,
      { level: "info", title: "Test" },
      deterministicId,
    );

    const s2 = markAllAsRead(s1);

    const result = await notificationContextProvider({
      pluginId: "core-notification",
      runtimeId: "notification-background",
      locale: "en-US",
      state: { "core-notification": s2 },
    });

    expect(result).toBeNull();
  });

  it("uses Chinese content for zh-CN locale", async () => {
    resetIds();
    const { state } = addNotification(
      EMPTY_STATE,
      { level: "warning", title: "危险" },
      deterministicId,
    );

    const result = (await notificationContextProvider({
      pluginId: "core-notification",
      runtimeId: "notification-background",
      locale: "zh-CN",
      state: { "core-notification": state },
    })) as Record<string, unknown>;

    expect(result).not.toBeNull();
    expect(result.title as string).toMatch(/通知|未读/);
    expect(result.content as string).toContain("危险");
  });

  it("returns priority 30", async () => {
    resetIds();
    const { state } = addNotification(
      EMPTY_STATE,
      { level: "info", title: "Notice" },
      deterministicId,
    );

    const result = (await notificationContextProvider({
      pluginId: "core-notification",
      runtimeId: "notification-background",
      locale: "en-US",
      state: { "core-notification": state },
    })) as Record<string, unknown>;

    expect(result.priority).toBe(30);
  });
});
