import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { SessionRecord } from "@/services/api.js";
import type { StreamMessage } from "@/stores/session-store.js";
import {
  SetupProgressNotice,
  setupProgress,
} from "../setup-progress-notice.js";

const done = {
  state: "done",
  resolution: "completed",
  generation: 1,
  attempts: 1,
  completedAt: "2026-10-10T00:00:00.000Z",
  pluginVersion: "1.0.0",
} as const;
const session = (
  setupRuntimes: SessionRecord["setupRuntimes"],
  phase: SessionRecord["phase"] = "setup",
) => ({ id: "s", status: "active", phase, setupRuntimes }) as SessionRecord;
const message = (overrides: Partial<StreamMessage>): StreamMessage => ({
  id: "m1",
  role: "assistant",
  content: "The world wakes.",
  timestamp: "2026-10-10T00:00:00.000Z",
  ...overrides,
});
const form = message({
  id: "form",
  block: { type: "interactive_form", data: { fields: [{ name: "name" }] } },
});
const idle = {
  messages: [message({})],
  submittedBlockIds: new Set<string>(),
  executing: false,
};

describe("setupProgress", () => {
  it("reports a failed step with its error and the steps to re-arm", () => {
    expect(
      setupProgress({
        ...idle,
        session: session({
          opening: done,
          "world/schema": {
            state: "blocked",
            pluginVersion: "1.0.0",
            generation: 1,
            attempts: 1,
            reason: "setup exhausted its retry budget",
            blockedAt: "2026-10-10T00:00:00.000Z",
            lastError: "401 Unauthorized",
          },
        }),
      }),
    ).toEqual({
      kind: "failed",
      blocked: ["world/schema"],
      error: "401 Unauthorized",
    });
    expect(
      setupProgress({
        ...idle,
        session: session({
          "hero/create": {
            state: "pending",
            pluginVersion: "1.0.0",
            generation: 1,
            attempts: 2,
            lastError: "LLM retry exhausted",
          },
        }),
      }),
    ).toEqual({ kind: "failed", blocked: [], error: "LLM retry exhausted" });
  });

  it("offers to continue when a submitted form was never followed by a run", () => {
    expect(
      setupProgress({
        ...idle,
        messages: [form],
        submittedBlockIds: new Set(["form"]),
        session: session({ opening: done }),
      }),
    ).toEqual({ kind: "unfinished", blocked: [] });
  });

  it("stays out of the way of the hero, an open form, a run and the game", () => {
    const failing = session({
      "hero/create": {
        state: "pending",
        pluginVersion: "1.0.0",
        generation: 1,
        attempts: 1,
        lastError: "boom",
      },
    });
    expect(
      setupProgress({ ...idle, session: failing, messages: [] }),
    ).toBeNull();
    expect(
      setupProgress({ ...idle, session: failing, messages: [form] }),
    ).toBeNull();
    expect(
      setupProgress({ ...idle, session: failing, executing: true }),
    ).toBeNull();
    expect(
      setupProgress({
        ...idle,
        session: failing,
        recovery: {
          sessionId: "s",
          hydrating: false,
          checking: false,
          status: { state: "interrupted", turnId: "t" },
        },
      }),
    ).toBeNull();
    expect(
      setupProgress({ ...idle, session: session({}, "playing") }),
    ).toBeNull();
  });
});

describe("SetupProgressNotice", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await i18n.changeLanguage("en-US");
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("re-arms every blocked step, then runs setup again", async () => {
    const calls: string[] = [];
    const onRearm = vi.fn(async (runtimeId: string) => {
      calls.push(`rearm:${runtimeId}`);
    });
    const onRun = vi.fn(() => calls.push("run"));
    render(
      <SetupProgressNotice
        progress={{ kind: "failed", blocked: ["a/setup", "b/setup"] }}
        onRearm={onRearm}
        onRun={onRun}
        onOpenSettings={vi.fn()}
      />,
    );
    // The session record trails the end of a run; nothing shows before it settles.
    expect(screen.queryByTestId("setup-progress-notice")).toBeNull();
    act(() => vi.advanceTimersByTime(1500));
    fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
    await act(async () => {});
    expect(calls).toEqual(["rearm:a/setup", "rearm:b/setup", "run"]);
  });

  it("does not run setup when a step could not be re-armed", async () => {
    const onRun = vi.fn();
    render(
      <SetupProgressNotice
        progress={{ kind: "failed", blocked: ["a/setup"] }}
        onRearm={async () => {
          throw new Error("offline");
        }}
        onRun={onRun}
        onOpenSettings={vi.fn()}
      />,
    );
    act(() => vi.advanceTimersByTime(1500));
    fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
    await act(async () => {});
    expect(onRun).not.toHaveBeenCalled();
    expect(screen.getByText(/Could not restart setup/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Retry setup" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it.each([
    ["401 Unauthorized", "auth", "llm.providers"],
    ["403 Forbidden", "forbidden", "llm.slots"],
    ["404 Unknown model", "notFound", "llm.slots"],
    ["429 Too many requests", "rateLimited", "llm.slots"],
  ])("opens settings for %s and leaves retry secondary", (error, kind, key) => {
    const onOpenSettings = vi.fn();
    const onRun = vi.fn();
    const onRearm = vi.fn();
    render(
      <SetupProgressNotice
        progress={{ kind: "failed", blocked: ["world/setup"], error }}
        onRearm={onRearm}
        onRun={onRun}
        onOpenSettings={onOpenSettings}
      />,
    );
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByRole("alert").getAttribute("data-kind")).toBe("failed");
    expect(screen.getByText(i18n.t(`error.actionable.${kind}`))).toBeTruthy();
    expect(screen.queryByText(i18n.t("session.setupFailedDetail"))).toBeNull();
    expect(screen.queryByText(error)).toBeNull();
    const settings = screen.getByRole("button", { name: "Model settings" });
    expect(settings.getAttribute("data-variant")).toBe("default");
    expect(
      screen
        .getByRole("button", { name: "Retry setup" })
        .getAttribute("data-variant"),
    ).toBe("outline");
    fireEvent.click(settings);
    expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith(key);
    expect(onRearm).not.toHaveBeenCalled();
    expect(onRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(screen.getByText(error)).toBeTruthy();
  });

  it.each(["Request timed out", "503 Service unavailable", undefined])(
    "keeps retry primary for a failure without a settings fix: %s",
    (error) => {
      render(
        <SetupProgressNotice
          progress={{ kind: "failed", blocked: [], error }}
          onRearm={vi.fn()}
          onRun={vi.fn()}
          onOpenSettings={vi.fn()}
        />,
      );
      act(() => vi.advanceTimersByTime(1500));
      expect(
        screen
          .getByRole("button", { name: "Retry setup" })
          .getAttribute("data-variant"),
      ).toBe("default");
      expect(
        screen.queryByRole("button", { name: "Model settings" }),
      ).toBeNull();
    },
  );

  it("offers a primary continue action for unfinished setup", () => {
    const onRun = vi.fn();
    render(
      <SetupProgressNotice
        progress={{ kind: "unfinished", blocked: [] }}
        onRearm={vi.fn()}
        onRun={onRun}
        onOpenSettings={vi.fn()}
      />,
    );
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByRole("status").getAttribute("data-kind")).toBe(
      "unfinished",
    );
    const button = screen.getByRole("button", { name: "Continue setup" });
    expect(button.getAttribute("data-variant")).toBe("default");
    fireEvent.click(button);
    expect(onRun).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Model settings" })).toBeNull();
  });
});
