import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { subscribeToast, type ToastEvent } from "@/lib/toast-channel.js";
import { enableSessionPlugin, disableSessionPlugin } from "../api/sessions.js";
import { ApiError } from "../api/request.js";

const realFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = realFetch;
  await i18n.changeLanguage("zh-CN");
});

describe.each(["zh-CN", "en-US", "ru-RU"])(
  "plugin toggle failures in %s",
  (locale) => {
    it.each([
      ["dimension_provider_conflict", "dimensionProviderConflict", true],
      ["dimension_provider_required", "dimensionProviderRequired", false],
      ["approval_queue_full", "approvalQueueFull", true],
      ["missing-provider", "missingProvider", true],
      ["session_not_active", "sessionNotActive", false],
      ["future_server_code", "generic", true],
    ] as const)("localizes %s", async (code, key, enable) => {
      await i18n.changeLanguage(locale);
      const body = {
        error: "Server diagnostic with plugin identifiers",
        code,
        details: { candidates: ["one", "two"] },
      };
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(body), { status: 409 }));
      const toasts: ToastEvent[] = [];
      const unsubscribe = subscribeToast((event) => toasts.push(event));
      try {
        await expect(
          (enable ? enableSessionPlugin : disableSessionPlugin)(
            "session",
            "plugin",
          ),
        ).rejects.toMatchObject({ code });
        expect(toasts).toHaveLength(1);
        const expected = i18n.t(`plugin.toggleError.${key}`);
        expect(expected).not.toBe(`plugin.toggleError.${key}`);
        expect(toasts[0]).toMatchObject({ kind: "error", message: expected });
        // Only an unexpected failure shows the server's response.
        if (key === "generic") {
          expect(toasts[0]?.detail).toContain(body.error);
          expect(toasts[0]?.detail).toContain(code);
        } else {
          expect(toasts[0]?.detail).toBeUndefined();
        }
      } finally {
        unsubscribe();
      }
    });
  },
);

it("names the plugin that holds the session's dimensions", async () => {
  await i18n.changeLanguage("en-US");
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        error: 'This change would disable "rival-dims"',
        code: "dimension_provider_required",
        details: {
          pluginId: "rival-dims",
          displayName: { "en-US": "Rival Dimensions", "zh-CN": "对手维度" },
        },
      }),
      { status: 409 },
    ),
  );
  const toasts: ToastEvent[] = [];
  const unsubscribe = subscribeToast((event) => toasts.push(event));
  try {
    await expect(
      enableSessionPlugin("session", "qa-dims"),
    ).rejects.toBeInstanceOf(ApiError);
    expect(toasts[0]?.message).toBe(
      '"Rival Dimensions" holds this session\'s dimensions and must stay enabled.',
    );
  } finally {
    unsubscribe();
  }
});

it("keeps successful toggles silent", async () => {
  globalThis.fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ ok: true, activePluginIds: [] })),
    );
  const toast = vi.fn();
  const unsubscribe = subscribeToast(toast);
  try {
    await disableSessionPlugin("session", "plugin");
    expect(toast).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
  }
});

it("preserves structured errors for callers", async () => {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        error: "Conflict",
        code: "dimension_provider_conflict",
      }),
      { status: 409 },
    ),
  );
  await expect(enableSessionPlugin("session", "plugin")).rejects.toBeInstanceOf(
    ApiError,
  );
});

it("uses a localized generic message for a transport failure", async () => {
  const failure = new Error("Connection refused");
  globalThis.fetch = vi.fn().mockRejectedValue(failure);
  const toasts: ToastEvent[] = [];
  const unsubscribe = subscribeToast((event) => toasts.push(event));
  try {
    await expect(disableSessionPlugin("session", "plugin")).rejects.toBe(
      failure,
    );
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      message: i18n.t("plugin.toggleError.generic"),
      detail: expect.stringContaining("Connection refused"),
    });
  } finally {
    unsubscribe();
  }
});
