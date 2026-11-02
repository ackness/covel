import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { StreamMessage } from "@/stores/session-store.js";
import { SessionStateContext } from "@/stores/session-store/context.js";
import { initialState } from "@/stores/session-store/reducer.js";
import { ChatMessageRenderer } from "../chat-message-renderer.js";

vi.mock("@/stores/ui-slot-store.js", () => ({ useUiSlots: () => [] }));
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("zh-CN");
});
const story: StreamMessage = {
  id: "story",
  role: "assistant",
  kind: "story",
  content: "The guide speaks.",
  segments: [{ kind: "narration", text: "The guide speaks." }],
  timestamp: "now",
  operationFailures: { count: 1 },
};
function Message({
  msg = story,
  mode = "parsed",
  template = false,
}: {
  msg?: StreamMessage;
  mode?: "parsed" | "detailed" | "raw";
  template?: boolean;
}) {
  return (
    <SessionStateContext.Provider
      value={{
        ...initialState,
        segmentUiSpecs: template
          ? [
              {
                pluginId: "template",
                specs: [
                  {
                    id: "paragraph",
                    label: undefined,
                    match: { kind: "narration" },
                    view: {
                      component: "Text",
                      props: { content: { $state: "/segment/text" } },
                    },
                  },
                ],
              },
            ]
          : [],
      }}
    >
      <ChatMessageRenderer
        msg={msg}
        viewMode={mode}
        isImageGenActive={false}
        sessionId="session"
        executing={false}
        generatingImage={false}
        onGenerateImage={() => {}}
        t={i18n.t}
      />
    </SessionStateContext.Provider>
  );
}
describe("host operation failure footer", () => {
  it.each(["parsed", "detailed"] as const)(
    "keeps prose and plugin templates unchanged in %s",
    (mode) => {
      for (const template of [false, true]) {
        const { container, rerender, unmount } = render(
          <Message
            mode={mode}
            template={template}
            msg={{ ...story, operationFailures: undefined }}
          />,
        );
        const before = container.innerHTML;
        rerender(<Message mode={mode} template={template} />);
        const notice = screen.getByTestId("story-operation-failure-notice");
        expect(notice.closest("[data-segment-template]")).toBeNull();
        expect(notice.closest(".ui-narrative")).toBeNull();
        expect(notice.getAttribute("role")).toBeNull();
        expect(notice.textContent).toContain("1");
        notice.remove();
        expect(container.innerHTML).toBe(before);
        unmount();
      }
    },
  );
  it.each([
    ["en-US", 1, "1 action from this turn did not take effect."],
    ["en-US", 2, "2 actions from this turn did not take effect."],
    ["zh-CN", 2, "本回合有 2 个操作没有生效。"],
    ["ru-RU", 1, "1 действие из этого хода не вступило в силу."],
    ["ru-RU", 2, "2 действия из этого хода не вступили в силу."],
    ["ru-RU", 5, "5 действий из этого хода не вступили в силу."],
    ["ru-RU", 1.5, undefined],
  ] as const)(
    "renders localized count in %s (%s)",
    async (locale, count, text) => {
      await i18n.changeLanguage(locale);
      render(<Message msg={{ ...story, operationFailures: { count } }} />);
      expect(
        screen.queryByTestId("story-operation-failure-notice")?.textContent,
      ).toBe(text);
    },
  );
  it("changes the historic footer's language without changing the story", async () => {
    await i18n.changeLanguage("en-US");
    render(<Message />);
    expect(
      screen.getByTestId("story-operation-failure-notice").textContent,
    ).toContain("1 action");
    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });
    expect(
      screen.getByTestId("story-operation-failure-notice").textContent,
    ).toBe("本回合有 1 个操作没有生效。");
    expect(screen.getByText(story.content).textContent).toBe(story.content);
  });
  it.each([
    { operationFailures: undefined },
    { role: "user" as const },
    { role: "system" as const },
    { kind: "plugin" },
    { operationFailures: { count: 0 } },
    { operationFailures: { count: 1, summary: "PRIVATE-SUMMARY" } },
  ])("renders no marker for invalid or non-story data %j", (extra) => {
    render(<Message mode="detailed" msg={{ ...story, ...extra }} />);
    expect(screen.queryByTestId("story-operation-failure-notice")).toBeNull();
    expect(document.body.textContent).not.toContain("PRIVATE-SUMMARY");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
  it("raw mode includes only the validated structured field", () => {
    const { rerender } = render(<Message mode="raw" />);
    expect(screen.queryByTestId("story-operation-failure-notice")).toBeNull();
    expect(document.body.textContent).toContain('"operationFailures"');
    rerender(
      <Message
        mode="raw"
        msg={
          {
            ...story,
            operationFailures: { count: 1, summary: "PRIVATE-SUMMARY" },
          } as StreamMessage
        }
      />,
    );
    expect(document.body.textContent).not.toContain("PRIVATE-SUMMARY");
    expect(document.body.textContent).not.toContain('"operationFailures"');
  });
});
