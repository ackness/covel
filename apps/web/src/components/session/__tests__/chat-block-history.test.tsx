import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/index.js";
import { ChatBlockRenderer } from "../chat-messages/chat-block-renderer.js";

const lifecycle = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn() }));
vi.mock("../chat-messages/message-blocks.js", () => ({
  PluginMessageBlock: () => {
    useEffect(() => {
      lifecycle.mount();
      return lifecycle.unmount;
    }, []);
    return <p>Historical plugin panel</p>;
  },
  MessageBlockRenderer: () => null,
  UiRenderBlock: () => null,
}));

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

it("mounts a historical plugin message only while its disclosure is open", () => {
  render(
    <ChatBlockRenderer
      msg={{
        id: "plugin-message:notes:turn-1",
        role: "assistant",
        kind: "plugin-message",
        content: "",
        timestamp: "2026-10-07T00:00:00Z",
        turnId: "turn-1",
        block: { type: "plugin_message", data: { pluginId: "notes" } },
      }}
      index={0}
      lastUserMsgIndex={1}
      viewMode="parsed"
      sessionId="session-1"
      executing={false}
      submittedBlockIds={new Set()}
      submittedBlockValues={{}}
      onSendMessage={() => {}}
      onSubmitBlock={() => {}}
      plugins={[
        { id: "notes", displayName: { en: "Field Notes", zh: "旅途札记" } },
      ]}
      t={i18n.t}
    />,
  );
  expect(screen.getByText("Field Notes · expand to review")).toBeTruthy();
  const disclosure = screen.getByTestId(
    "history-interaction",
  ) as HTMLDetailsElement;
  expect(lifecycle.mount).not.toHaveBeenCalled();
  expect(screen.queryByText("Historical plugin panel")).toBeNull();
  act(() => {
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
  });
  expect(screen.getByText("Historical plugin panel")).toBeTruthy();
  expect(lifecycle.mount).toHaveBeenCalledOnce();
  act(() => {
    disclosure.open = false;
    fireEvent(disclosure, new Event("toggle"));
  });
  expect(screen.queryByText("Historical plugin panel")).toBeNull();
  expect(lifecycle.unmount).toHaveBeenCalledOnce();
});

it.each([
  [
    "zh-CN",
    [{ id: "notes", displayName: { en: "Field Notes", zh: "旅途札记" } }],
    "旅途札记 · 展开查看",
  ],
  ["en-US", [], "Plugin content · expand to review"],
] as const)(
  "names history with the provider or a neutral fallback in %s",
  async (locale, plugins, label) => {
    await i18n.changeLanguage(locale);
    render(
      <ChatBlockRenderer
        msg={{
          id: "m",
          role: "assistant",
          content: "",
          timestamp: "",
          block: { type: "plugin_message", data: { pluginId: "notes" } },
        }}
        index={0}
        lastUserMsgIndex={1}
        viewMode="parsed"
        sessionId="s"
        executing={false}
        submittedBlockIds={new Set()}
        submittedBlockValues={{}}
        onSendMessage={() => {}}
        onSubmitBlock={() => {}}
        plugins={plugins}
        t={i18n.t}
      />,
    );
    expect(screen.getByText(label)).toBeTruthy();
  },
);
