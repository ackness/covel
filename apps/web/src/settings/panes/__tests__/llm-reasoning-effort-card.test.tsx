import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ReasoningEffortProfile } from "@/services/api.js";
import { ReasoningEffortCard } from "../llm-reasoning-effort-card.js";

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

const kimi: ReasoningEffortProfile = {
  family: "compatible",
  defaultValue: "max",
  requestDefault: "high",
  sampling: { fixed: ["temperature", "topP"] },
  options: [{ value: "low" }, { value: "high" }, { value: "max" }],
};

describe("reasoning effort card hints", () => {
  it("names the level sent by default and the sampling the model fixes", () => {
    render(
      <ReasoningEffortCard
        profile={kimi}
        override={undefined}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/With no level chosen, Covel sends/)).toBeTruthy();
    expect(screen.getByText(/sets temperature, Top P itself/)).toBeTruthy();
  });

  it("drops the default-level hint once a level is chosen", () => {
    render(
      <ReasoningEffortCard profile={kimi} override="low" onChange={vi.fn()} />,
    );
    expect(screen.queryByText(/With no level chosen/)).toBeNull();
  });

  it("warns about ignored sampling only while thinking is on", () => {
    const deepseek: ReasoningEffortProfile = {
      family: "deepseek",
      sampling: { ignoredWhileThinking: true },
      options: [{ value: "disabled" }, { value: "high" }],
    };
    const view = render(
      <ReasoningEffortCard
        profile={deepseek}
        override="high"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/ignores temperature/)).toBeTruthy();
    view.rerender(
      <ReasoningEffortCard
        profile={deepseek}
        override="disabled"
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByText(/ignores temperature/)).toBeNull();
  });
});
