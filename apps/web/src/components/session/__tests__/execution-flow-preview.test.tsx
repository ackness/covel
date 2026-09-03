import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { UseRuntimeBindingsResult } from "@/hooks/use-runtime-bindings.js";
import { ExecutionFlowPreview } from "../session-prep/execution-flow-preview.js";

describe("ExecutionFlowPreview turn completion", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
  });

  afterEach(() => cleanup());

  it("marks detached steps without crowding awaited steps", () => {
    const bindingState: UseRuntimeBindingsResult = {
      entries: [],
      allBound: true,
      bindings: {},
      setBinding: vi.fn(),
      autoAssign: vi.fn(),
      compatibleSlots: vi.fn(() => []),
    };
    const steps = [
      {
        pluginId: "mimo-tts",
        runtimeId: "mimo-tts/auto-narrate",
        label: "auto-narrate",
        stage: "post-turn" as const,
        segmentId: "post-turn" as const,
        trigger: { type: "auto" },
        runtimeType: "function",
        capabilities: ["tts"],
        turnCompletion: { mode: "detached" as const },
      },
      {
        pluginId: "guide",
        runtimeId: "guide",
        label: "guide",
        stage: "post-turn" as const,
        segmentId: "post-turn" as const,
        trigger: { type: "auto" },
        runtimeType: "agent",
        turnCompletion: { mode: "await" as const },
      },
    ];

    render(
      <ExecutionFlowPreview
        flowData={{
          steps,
          segments: [{ id: "post-turn", label: "Post-Turn" }],
        }}
        selectedFlowSteps={steps}
        bindingState={bindingState}
      />,
    );

    expect(screen.getByText("Background")).toBeTruthy();
    expect(
      screen.getByLabelText(
        "Runs in the background without blocking the foreground flow",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Media")).toBeTruthy();
    expect(screen.getAllByText(/auto-narrate|guide/)).toHaveLength(2);
  });
});
