import { lazy, type ComponentType } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import "@/i18n/index.js";
import { SessionRecoveryBoundary } from "../session-recovery-boundary.js";

afterEach(cleanup);

it.each(["running", "interrupted"] as const)(
  "keeps %s recovery reachable while the game surface is loading",
  async (state) => {
    let load!: (module: { default: ComponentType }) => void;
    const pending = new Promise<{ default: ComponentType }>((resolve) => {
      load = resolve;
    });
    const Surface = lazy(() => pending);
    const retry = vi.fn();
    const stop = vi.fn(async () => {});
    render(
      <SessionRecoveryBoundary
        recovery={{
          sessionId: "s",
          hydrating: false,
          checking: false,
          status: {
            state,
            turnId: "t",
            ...(state === "interrupted"
              ? { retry: { type: "retry_turn" as const, payload: {} } }
              : {}),
          },
        }}
        onRetry={retry}
        onRefresh={vi.fn()}
        onStop={stop}
        onOpenSettings={vi.fn()}
        loading={<p>Loading surface</p>}
      >
        <Surface />
      </SessionRecoveryBoundary>,
    );
    const notice = screen.getByTestId("execution-recovery-notice");
    expect(notice.getAttribute("role")).toBe(
      state === "running" ? "status" : "alert",
    );
    expect(screen.getByText("Loading surface")).toBeDefined();
    expect(retry).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    if (state === "interrupted") {
      fireEvent.click(screen.getByRole("button", { name: "重试未完成回合" }));
      expect(retry).toHaveBeenCalledTimes(1);
    }
    await act(async () => {
      load({ default: () => <p>Ready surface</p> });
      await pending;
    });
    expect(screen.getByText("Ready surface")).toBeDefined();
    expect(screen.queryByTestId("execution-recovery-notice")).toBeNull();
  },
);
