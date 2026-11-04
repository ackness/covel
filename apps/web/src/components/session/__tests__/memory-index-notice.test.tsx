import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMemoryIndexStatus } from "@covel/shared";
import i18n from "@/i18n";
import { NoticeHost } from "@/components/ui/notice-host.js";
import { getSettings, initSettings } from "@/settings/store.js";

const api = vi.hoisted(() => ({
  getSessionMemoryIndex: vi.fn(),
  rebuildSessionMemoryIndex: vi.fn(),
}));
vi.mock("@/services/api", () => api);

import { MemoryIndexNotice } from "../memory-index-notice.js";

const stale: SessionMemoryIndexStatus = {
  available: true,
  locked: {
    provider: "openai",
    modelName: "text-embedding-3-small",
    dim: 1536,
    lockedAt: null,
  },
  configured: { provider: "ollama", modelName: "nomic-embed-text" },
  stale: true,
};

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  api.getSessionMemoryIndex.mockReset();
  api.rebuildSessionMemoryIndex.mockReset();
});
afterEach(cleanup);

function mount(refreshKey?: unknown) {
  const tree = (key?: unknown) => (
    <>
      <MemoryIndexNotice sessionId="s" refreshKey={key} />
      <NoticeHost />
    </>
  );
  const view = render(tree(refreshKey));
  return { rerender: (key: unknown) => view.rerender(tree(key)) };
}

describe("memory index notice", () => {
  it("names both models and rebuilds the index on request", async () => {
    api.getSessionMemoryIndex.mockResolvedValue(stale);
    api.rebuildSessionMemoryIndex.mockResolvedValue({
      ...stale,
      locked: { ...stale.locked!, modelName: "nomic-embed-text" },
      stale: false,
    });
    mount();
    expect(
      await screen.findByText(/openai\/text-embedding-3-small/),
    ).toBeTruthy();
    expect(screen.getByText(/ollama\/nomic-embed-text/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rebuild index" }));
    await waitFor(() =>
      expect(screen.queryByTestId("notice-memory-index")).toBeNull(),
    );
    expect(api.rebuildSessionMemoryIndex).toHaveBeenCalledWith("s");
  });

  it("offers to clear the index only in developer mode when no embedding model is configured", async () => {
    api.getSessionMemoryIndex.mockResolvedValue({
      ...stale,
      configured: null,
    });
    await initSettings();
    const view = mount();
    expect(await screen.findByTestId("notice-memory-index")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear index" })).toBeNull();
    await act(async () => {
      await getSettings().set("ui.developerView", true);
    });
    expect(
      await screen.findByRole("button", { name: "Clear index" }),
    ).toBeTruthy();
    await act(async () => {
      await getSettings().set("ui.developerView", false);
    });
    view.rerender(1);
  });

  it("keeps the notice and says why when the rebuild fails", async () => {
    api.getSessionMemoryIndex.mockResolvedValue(stale);
    api.rebuildSessionMemoryIndex.mockRejectedValue(
      new Error("401 invalid key"),
    );
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Rebuild index" }),
    );
    expect(await screen.findByText(/401 invalid key/)).toBeTruthy();
    expect(screen.getByTestId("notice-memory-index")).toBeTruthy();
  });

  it("shows nothing while the index matches the configuration or cannot be read", async () => {
    api.getSessionMemoryIndex.mockResolvedValueOnce({ ...stale, stale: false });
    const { rerender } = mount(1);
    await waitFor(() => expect(api.getSessionMemoryIndex).toHaveBeenCalled());
    expect(screen.queryByTestId("notice-memory-index")).toBeNull();
    api.getSessionMemoryIndex.mockRejectedValueOnce(new Error("not found"));
    rerender(2);
    await waitFor(() =>
      expect(api.getSessionMemoryIndex).toHaveBeenCalledTimes(2),
    );
    expect(screen.queryByTestId("notice-memory-index")).toBeNull();
  });
});
