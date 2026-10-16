import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ExecutionRecoveryNotice } from "../execution-recovery-notice.js";
import type {
  ExecutionRecovery,
  ExecutionStep,
} from "@/stores/session-store/types.js";

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(cleanup);
const interrupted: ExecutionRecovery = {
  sessionId: "s",
  hydrating: false,
  checking: false,
  status: {
    state: "interrupted",
    turnId: "t",
    retry: { type: "retry_turn", payload: {} },
  },
};
function setup(recovery: ExecutionRecovery, steps: ExecutionStep[] = []) {
  const onRetry = vi.fn();
  const onRefresh = vi.fn();
  const onStop = vi.fn(async () => {});
  const onOpenSettings = vi.fn();
  render(
    <ExecutionRecoveryNotice
      recovery={recovery}
      steps={steps}
      onOpenSettings={onOpenSettings}
      onRetry={onRetry}
      onRefresh={onRefresh}
      onStop={onStop}
    />,
  );
  return { onRetry, onRefresh, onStop, onOpenSettings };
}

describe("execution recovery notice", () => {
  it.each([
    ["401 Authentication Fails (governor)", "auth", "llm.providers"],
    ["403 Forbidden", "forbidden", "llm.slots"],
    ["404 Unknown model", "notFound", "llm.slots"],
    ["429 Too many requests", "rateLimited", "llm.slots"],
  ])(
    "makes settings primary for %s using only this execution's error",
    (error, kind, key) => {
      const step: ExecutionStep = {
        runtimeId: "story",
        pluginId: "story",
        turnId: "t",
        status: "failed",
        detail: error,
      };
      const { onOpenSettings, onRetry, onRefresh } = setup(
        { ...interrupted, status: { ...interrupted.status!, state: "failed" } },
        [
          { ...step, turnId: "older", detail: "Wrong historical error" },
          step,
          { ...step, runtimeId: "later", detail: "Another runtime failed" },
        ],
      );
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(screen.getByText(i18n.t(`error.actionable.${kind}`))).toBeTruthy();
      expect(
        screen.queryByText(i18n.t("session.recoveryInterruptedDetail")),
      ).toBeNull();
      const settings = screen.getByRole("button", { name: "Model settings" });
      const retry = screen.getByRole("button", {
        name: "Retry unfinished turn",
      });
      expect(settings.getAttribute("data-variant")).toBe("default");
      expect(retry.getAttribute("data-variant")).toBe("outline");
      fireEvent.click(settings);
      expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith(key);
      expect(onRetry).not.toHaveBeenCalled();
      expect(screen.queryByText(error)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Show details" }));
      expect(screen.getByText(error)).toBeTruthy();
      expect(screen.queryByText("Wrong historical error")).toBeNull();
      expect(screen.queryByText("Another runtime failed")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Check status" }));
      expect(onRefresh).toHaveBeenCalledOnce();
      fireEvent.click(retry);
      fireEvent.click(retry);
      expect(onRetry).toHaveBeenCalledOnce();
    },
  );

  it("keeps retry primary for a failure without a settings remedy", () => {
    setup(
      { ...interrupted, status: { ...interrupted.status!, state: "failed" } },
      [
        {
          runtimeId: "story",
          pluginId: "story",
          turnId: "t",
          status: "failed",
          detail: "Request timed out",
        },
      ],
    );
    expect(screen.getByText(i18n.t("error.actionable.timeout"))).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Retry unfinished turn" })
        .getAttribute("data-variant"),
    ).toBe("default");
    expect(screen.queryByRole("button", { name: "Model settings" })).toBeNull();
  });

  it("keeps the existing interrupted notice when no runtime recorded a cause", () => {
    setup(interrupted, [
      {
        runtimeId: "old",
        pluginId: "old",
        turnId: "older",
        status: "failed",
        detail: "401 Unauthorized",
      },
      {
        runtimeId: "story",
        pluginId: "story",
        turnId: "t",
        status: "failed",
        detail: "__i18n:session.reasonInterrupted__",
      },
    ]);
    expect(
      screen.getByText(i18n.t("session.recoveryInterrupted")),
    ).toBeTruthy();
    expect(
      screen.getByText(i18n.t("session.recoveryInterruptedDetail")),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Retry unfinished turn" })
        .getAttribute("data-variant"),
    ).toBe("default");
    expect(screen.queryByRole("button", { name: "Model settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show details" })).toBeNull();
  });
  it("offers Continue in the stopped opening row without running it automatically", () => {
    const { onRetry } = setup({
      ...interrupted,
      status: {
        ...interrupted.status!,
        state: "failed",
        abortReason: "aborted-by-player",
      },
    });
    expect(screen.getByText("Stopped; turn not committed")).toBeTruthy();
    expect(screen.queryByText("This turn failed")).toBeNull();
    expect(onRetry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
  it("names a recovered batch by its task count instead of offering a whole-turn retry", () => {
    const { onRetry } = setup({
      ...interrupted,
      status: {
        state: "interrupted",
        turnId: "retry-attempt",
        retry: {
          type: "retry_failed_runtimes",
          payload: { runtimeIds: ["a", "b"], retryFromTurnId: "original" },
        },
      },
    });
    expect(
      screen.queryByRole("button", { name: "Retry unfinished turn" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry failed tasks (2)" }),
    );
    expect(onRetry).toHaveBeenCalledOnce();
  });
  it("offers interrupted retry only on an explicit click and prevents duplicate clicks", () => {
    const { onRetry } = setup(interrupted);
    expect(onRetry).not.toHaveBeenCalled();
    const retry = screen.getByRole("button", { name: "Retry unfinished turn" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledOnce();
  });
  it("shows background continuation and stop while hydration has not published a session", async () => {
    const { onStop, onRefresh, onRetry } = setup({
      ...interrupted,
      hydrating: true,
      status: { state: "running", turnId: "t" },
    });
    expect(screen.getByText("Your turn is still running")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Retry unfinished turn" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop task" }));
    await waitFor(() => expect(onStop).toHaveBeenCalledOnce());
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });
  it("does not claim interruption or offer retry when the network result is unknown", () => {
    setup({ ...interrupted, error: "offline", checking: true });
    expect(screen.getByText("Checking the unfinished turn")).toBeTruthy();
    expect(screen.queryByText("This turn was interrupted")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Retry unfinished turn" }),
    ).toBeNull();
  });
  it("shows a status the server could not check as a check in progress, with no retry or stop (F-203)", () => {
    setup({
      ...interrupted,
      status: { state: "unknown", retry: { type: "retry_turn", payload: {} } },
    });
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("Checking the unfinished turn")).toBeTruthy();
    expect(
      screen.getByText(/cannot tell right now whether a turn is running/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Retry unfinished turn" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop task" })).toBeNull();
  });
  it.each([undefined, "restore failed"])(
    "shows stopped unknown checks while hydration remains unfinished (error: %s)",
    (error) => {
      const { onRefresh } = setup({
        ...interrupted,
        status: { state: "unknown" },
        hydrating: true,
        stalled: true,
        ...(error ? { error } : {}),
      });
      const notice = screen.getByRole("alert");
      expect(screen.getByText("Could not confirm the turn")).toBeTruthy();
      expect(notice.querySelector(".animate-spin")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Check status" }));
      expect(onRefresh).toHaveBeenCalledOnce();
    },
  );

  it("says when automatic checks stopped and checks again on request (F-203)", () => {
    const { onRefresh } = setup({
      ...interrupted,
      status: { state: "unknown" },
      stalled: true,
    });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Could not confirm the turn")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
