// @vitest-environment jsdom
import React from "react";

import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";

import { createInitialWorkspaceState } from "../src/state.js";
import { SessionWorkbench } from "../src/components/session-workbench.js";
import { renderWithI18n } from "./helpers/render-with-i18n.js";

function createProps() {
  return {
    activeSessionPresetId: "default-story",
    activeSessionPresetName: "Default story",
    canSend: false,
    composer: "",
    composerFormRef: React.createRef<HTMLFormElement>(),
    composerRef: React.createRef<HTMLTextAreaElement>(),
    emptyTimelinePrompt: "unused",
    newSessionPresetId: "default-story",
    normalizedSlashSelectedIndex: 0,
    pendingBlockRef: React.createRef<HTMLElement>(),
    newSessionPresetOptions: [],
    selectedSession: null,
    sessionPresetOptions: [],
    selectedWorld: null,
    sessions: [],
    showSlashMenu: false,
    slashSuggestions: [],
    status: "idle" as const,
    workbenchDescription: "风暴带边缘的浮桥城。",
    workbenchTitle: "雾港十三号",
    workspace: createInitialWorkspaceState(),
    onBlockSelection: vi.fn(),
    onComposerChange: vi.fn(),
    onComposerKeyDown: vi.fn(),
    onCreateArchive: vi.fn(),
    onCreateSession: vi.fn(),
    onNewSessionPresetChange: vi.fn(),
    onSendMessage: vi.fn(),
    onSessionPresetChange: vi.fn(),
    onSessionSelect: vi.fn(),
    onSlashSelect: vi.fn()
  };
}

describe("SessionWorkbench", () => {
  it("shows a true empty-world heading in Chinese when no world is selected", () => {
    renderWithI18n(<SessionWorkbench {...createProps()} />);

    expect(screen.getByRole("heading", { name: "先创建一个世界" })).toBeTruthy();
    expect(screen.getAllByText("先生成一个示例世界，立刻进入可交互的试玩状态。").length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "雾港十三号" })).toBeNull();
  });

  it("shows the English empty-world copy instead of the starter-world placeholder", () => {
    renderWithI18n(<SessionWorkbench {...createProps()} />, {
      locale: "en"
    });

    expect(screen.getByRole("heading", { name: "Create a world first" })).toBeTruthy();
    expect(screen.getAllByText("Spin up a starter world and drop straight into an interactive run.").length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "Mistharbor XIII" })).toBeNull();
  });
});
