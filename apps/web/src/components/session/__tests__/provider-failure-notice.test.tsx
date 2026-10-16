import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntimeSummary } from "@covel/shared";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";
import i18n from "@/i18n";
import { buildSnapshotExecutionSteps } from "@/stores/session-store/snapshot-execution-steps.js";
import { ExecutionRecoveryNotice } from "../execution-recovery-notice.js";
import {
  SetupProgressNotice,
  setupProgress,
} from "../setup-progress-notice.js";
import {
  SessionModelUsesContext,
  sessionModelUses,
} from "../provider-failure-notice.js";

const runtime = (
  model: string,
  runtimeType: "agent" | "function" = "agent",
): PluginRuntimeSummary => ({
  id: `fixture/${model}`,
  model,
  runtimeType,
  trigger: { type: "auto" },
  execution: "sync",
  turnCompletion: { mode: "await" },
  outputKind: "system",
});
const plugin = {
  active: true,
  hostState: "loaded" as const,
  runtimes: [runtime("story"), runtime("plugin")],
};
const slot = (slotId: string, provider = "deepseek"): ResolvedSlot => ({
  slotId,
  label: slotId,
  tag: "text",
  presetId: "",
  preset: null,
  serverProvider: provider,
  serverModel: "model",
  isAvailable: true,
});
const failureTarget = { provider: "deepseek", model: "recorded-model" };
const recovery = {
  sessionId: "s",
  checking: false,
  hydrating: false,
  status: {
    state: "failed" as const,
    turnId: "t",
    retry: { type: "retry_turn" as const, payload: {} },
  },
};

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function history(errorKind = "auth", error = "opaque provider response") {
  return buildSnapshotExecutionSteps([
    {
      type: "runtime.failed",
      turnId: "t",
      timestamp: "2026-10-16T00:00:00Z",
      payload: {
        runtimeId: "fixture/plugin",
        pluginId: "fixture",
        errorKind,
        error,
        failureTarget,
      },
    },
  ]);
}

describe("provider failure scope", () => {
  it("restores the target from history and names every active use sharing it", () => {
    const onOpenSettings = vi.fn();
    const steps = history();
    render(
      <SessionModelUsesContext.Provider
        value={sessionModelUses([plugin], [slot("story")])}
      >
        <ExecutionRecoveryNotice
          recovery={recovery}
          steps={steps}
          onOpenSettings={onOpenSettings}
          onRetry={vi.fn()}
          onRefresh={vi.fn()}
          onStop={vi.fn()}
        />
      </SessionModelUsesContext.Provider>,
    );
    expect(steps[0]?.failureTarget).toEqual(failureTarget);
    expect(screen.getByText(/DeepSeek rejected the API key/)).toBeTruthy();
    expect(
      screen.getByText(/Story and Plugin tasks — 2 model uses/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Model settings" }));
    expect(onOpenSettings).toHaveBeenCalledWith("llm.providers");
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(screen.getByText("opaque provider response")).toBeTruthy();
  });

  it("uses the setup clock's failing runtime and hydrates its provider", () => {
    vi.useFakeTimers();
    const steps = history();
    const progress = setupProgress({
      session: {
        id: "s",
        worldId: "world",
        status: "active",
        phase: "setup",
        completedPlayerTurns: 0,
        activePlugins: [],
        locale: "en-US",
        createdAt: "2026-10-16T00:00:00Z",
        updatedAt: "2026-10-16T00:00:00Z",
        setupRuntimes: {
          "fixture/plugin": {
            state: "pending",
            generation: 1,
            attempts: 1,
            pluginVersion: "1",
            lastError: "opaque provider response",
          },
        },
      },
      messages: [
        {
          id: "m",
          role: "system",
          content: "Welcome",
          timestamp: "2026-10-16T00:00:00Z",
        },
      ],
      submittedBlockIds: new Set(),
      executing: false,
      steps,
    });
    expect(progress?.failureTarget).toEqual(failureTarget);
    render(
      <SessionModelUsesContext.Provider
        value={sessionModelUses([plugin], [slot("story")])}
      >
        <SetupProgressNotice
          progress={progress}
          onRearm={vi.fn()}
          onRun={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </SessionModelUsesContext.Provider>,
    );
    act(() => vi.advanceTimersByTime(1500));
    expect(
      screen.getByText(/Story and Plugin tasks — 2 model uses/),
    ).toBeTruthy();
  });

  it.each([
    ["auth", "opaque response", /rejected the API key/],
    ["auth", "403 Forbidden", /denied access/],
    ["rate_limited", "opaque response", /rate-limiting requests/],
    ["quota", "opaque response", /no quota or balance/],
  ])(
    "names the provider for %s without a shared list when only one use routes there",
    (kind, error, message) => {
      render(
        <SessionModelUsesContext.Provider
          value={sessionModelUses(
            [plugin],
            [slot("story"), slot("plugin", "local")],
          )}
        >
          <ExecutionRecoveryNotice
            recovery={recovery}
            steps={history(kind, error)}
            onOpenSettings={vi.fn()}
            onRetry={vi.fn()}
            onRefresh={vi.fn()}
            onStop={vi.fn()}
          />
        </SessionModelUsesContext.Provider>,
      );
      expect(screen.getByText(message).textContent).toContain("DeepSeek");
      expect(screen.queryByText(/model uses in this session/)).toBeNull();
    },
  );

  it("keeps non-account errors unchanged and never infers a provider from text", () => {
    const renderNotice = (steps: ReturnType<typeof history>) => (
      <SessionModelUsesContext.Provider
        value={sessionModelUses([plugin], [slot("story")])}
      >
        <ExecutionRecoveryNotice
          recovery={recovery}
          steps={steps}
          onOpenSettings={vi.fn()}
          onRetry={vi.fn()}
          onRefresh={vi.fn()}
          onStop={vi.fn()}
        />
      </SessionModelUsesContext.Provider>
    );
    const view = render(renderNotice(history("timeout", "Request timed out")));
    expect(screen.getByText(i18n.t("error.actionable.timeout"))).toBeTruthy();
    expect(screen.queryByText(/model uses in this session/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Model settings" })).toBeNull();
    view.rerender(
      renderNotice(
        history(
          "auth",
          "[provider: deepseek, model: example] 401 Unauthorized",
        ).map((step) => ({ ...step, failureTarget: undefined })),
      ),
    );
    expect(screen.queryByText(/model uses in this session/)).toBeNull();
    expect(screen.getByText(i18n.t("error.actionable.auth"))).toBeTruthy();
  });

  it("uses current overrides and presets, excludes inactive runtimes, and deduplicates uses", () => {
    const uses = sessionModelUses(
      [
        {
          ...plugin,
          runtimes: [
            ...plugin.runtimes,
            runtime("utility", "function"),
            runtime("story"),
          ],
        },
        { ...plugin, active: false, runtimes: [runtime("unused")] },
      ],
      [
        slot("story"),
        slot("local", "local"),
        {
          ...slot("utility"),
          preset: {
            id: "custom",
            name: "Custom",
            provider: "local",
            model: "local-model",
            enabled: true,
            isDefault: false,
            scope: "custom",
          },
        },
      ],
      { "fixture/plugin": "local", "fixture/utility": "story" },
    );
    expect(uses).toEqual([
      { slotId: "story", provider: "deepseek" },
      { slotId: "local", provider: "local" },
      { slotId: "utility", provider: "local" },
    ]);
    expect(
      sessionModelUses([plugin], [{ ...slot("story"), isAvailable: false }]),
    ).toEqual([]);
  });
});
