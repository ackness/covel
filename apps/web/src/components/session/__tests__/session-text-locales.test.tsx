import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ActionableErrorKind } from "@/lib/actionable-error.js";
import { ActionableErrorNotice } from "@/components/shared/actionable-error-notice.js";
import { SessionCanvasHero } from "../chat-messages/session-canvas-hero.js";
import { ChatBlockRenderer } from "../chat-messages/chat-block-renderer.js";
import { JobListPanel } from "../image-plugin-panels/image-jobs-panel.js";
import { EconomyTab } from "@/components/world/tabs/economy-tab.js";
import { FactionsTab } from "@/components/world/tabs/factions-tab.js";
import { HistoryTab } from "@/components/world/tabs/history-tab.js";

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("zh-CN");
});

it.each([
  ["zh-CN", "§ 故事开场", "内容块：example", "进行中"],
  ["en-US", "§ SESSION CANVAS", "Block: example", "Running"],
  ["ru-RU", "§ НАЧАЛО ИСТОРИИ", "Блок: example", "Выполняется"],
])(
  "renders session text in %s",
  async (locale, eyebrow, blockLabel, running) => {
    await i18n.changeLanguage(locale);
    render(
      <>
        <SessionCanvasHero
          world={null}
          locale={locale}
          onBegin={vi.fn()}
          beginLabel="Start"
          hintLabel="Welcome"
        />
        <ChatBlockRenderer
          msg={{
            id: "block",
            role: "assistant",
            content: "",
            timestamp: "now",
            block: { type: "example" },
          }}
          index={0}
          lastUserMsgIndex={-1}
          viewMode="raw"
          sessionId="session"
          executing={false}
          submittedBlockIds={new Set()}
          submittedBlockValues={{}}
          onSendMessage={vi.fn()}
          onSubmitBlock={vi.fn()}
          t={i18n.t}
        />
        <JobListPanel
          props={{
            items: [
              { jobId: "job", status: "running" },
              { jobId: "custom", status: "Custom state" },
            ],
          }}
        />
      </>,
    );
    expect(screen.getByText(eyebrow)).toBeTruthy();
    expect(screen.getByText(blockLabel)).toBeTruthy();
    expect(screen.getByText(running)).toBeTruthy();
    expect(screen.getByText("Custom state")).toBeTruthy();
  },
);

const kinds: ActionableErrorKind[] = [
  "auth",
  "forbidden",
  "not-found",
  "rate-limited",
  "server",
  "timeout",
  "network",
  "invalid-output",
  "incomplete",
  "error",
  "unknown",
];
it.each(["zh-CN", "en-US", "ru-RU"])(
  "translates every error badge in %s and preserves diagnostic detail",
  async (locale) => {
    await i18n.changeLanguage(locale);
    for (const kind of kinds) {
      const label = i18n.t(`error.actionable.badge.${kind}`);
      expect(label).not.toBe(`error.actionable.badge.${kind}`);
      const view = render(
        <ActionableErrorNotice kind={kind} error="Original diagnostic" />,
      );
      expect(screen.getByText(label)).toBeTruthy();
      fireEvent.click(
        screen.getByRole("button", {
          name: i18n.t("error.actionable.showDetail"),
        }),
      );
      expect(screen.getByText("Original diagnostic")).toBeTruthy();
      view.unmount();
    }
  },
);

it.each(["zh-CN", "ru-RU"])(
  "uses locale-owned numbering for unnamed world entries in %s",
  async (locale) => {
    await i18n.changeLanguage(locale);
    const common = { dimensions: {}, onChange: vi.fn(), t: i18n.t };
    const economy = render(
      <EconomyTab
        {...common}
        dimensions={{
          economy: {
            currencies: [{ name: "", symbol: "", description: "" }],
            resources: [""],
          },
        }}
      />,
    );
    expect(
      screen.getByText(i18n.t("world.unnamedCurrency", { number: 1 })),
    ).toBeTruthy();
    expect(
      screen.getByRole("textbox", {
        name: i18n.t("world.numberedResource", { number: 1 }),
      }),
    ).toBeTruthy();
    economy.unmount();
    const factions = render(
      <FactionsTab
        {...common}
        dimensions={{
          factions: [
            {
              id: "f",
              name: "",
              type: "other",
              influence: "minor",
              description: "",
            },
          ],
        }}
      />,
    );
    expect(
      screen.getByText(i18n.t("world.unnamedFaction", { number: 1 })),
    ).toBeTruthy();
    factions.unmount();
    render(
      <HistoryTab
        {...common}
        dimensions={{
          history: [
            { name: "", year: "", description: "", significance: "minor" },
          ],
        }}
      />,
    );
    expect(
      screen.getByText(i18n.t("world.unnamedHistory", { number: 1 })),
    ).toBeTruthy();
  },
);
