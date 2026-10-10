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
});
