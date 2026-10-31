import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { PluginRuntimeSummary } from "@covel/shared";
import i18n from "@/i18n";
import { PluginModelNotice } from "../plugin-model-notice.js";

const runtime: PluginRuntimeSummary = {
  id: "notes",
  runtimeType: "agent",
  execution: "sync",
  stage: "post-turn",
  trigger: { type: "auto" },
  turnCompletion: { mode: "await" },
  outputKind: "system",
};
afterEach(cleanup);
it.each(["en-US", "zh-CN", "ru-RU"])(
  "renders localized model cost and cadence facts (%s)",
  async (locale) => {
    await i18n.changeLanguage(locale);
    const { rerender } = render(
      <PluginModelNotice
        runtimes={[
          {
            ...runtime,
            trigger: {
              type: "auto",
              every: 3,
              startTurn: 2,
              cooldownTurns: 4,
              maxTriggerCount: 5,
            },
          },
        ]}
      />,
    );
    const notice = () => screen.getByTestId("plugin-model-notice").textContent;
    expect(notice()).toContain(i18n.t("plugin.modelUse.notice"));
    for (const [key, count] of [
      ["scheduled", 3],
      ["start", 2],
      ["cooldown", 4],
      ["limit", 5],
    ] as const)
      expect(notice()).toContain(i18n.t(`plugin.modelUse.${key}`, { count }));
    for (const [key, extra] of [
      [
        "manual",
        { trigger: { type: "manual" as const, every: 3, maxTriggerCount: 5 } },
      ],
      ["event", { trigger: { type: "event" as const, topic: "note.updated" } }],
      ["setup", { stage: "setup" as const }],
      ["delegated", { subagentOnly: true }],
    ] as const) {
      rerender(<PluginModelNotice runtimes={[{ ...runtime, ...extra }]} />);
      expect(notice()).toContain(i18n.t(`plugin.modelUse.${key}`));
      expect(notice()).not.toContain(
        i18n.t("plugin.modelUse.scheduled", { count: 3 }),
      );
      expect(notice()).not.toContain(
        i18n.t("plugin.modelUse.limit", { count: 5 }),
      );
    }
    rerender(<PluginModelNotice runtimes={[]} />);
    expect(screen.queryByTestId("plugin-model-notice")).toBeNull();
    rerender(
      <PluginModelNotice
        runtimes={[{ ...runtime, runtimeType: "function" }]}
      />,
    );
    expect(screen.queryByTestId("plugin-model-notice")).toBeNull();
  },
);
