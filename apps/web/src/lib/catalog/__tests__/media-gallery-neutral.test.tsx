import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import i18n from "@/i18n";
import { MediaGalleryPanel } from "@/components/session/image-plugin-panels/image-gallery-panel.js";
import { JobListPanel } from "@/components/session/image-plugin-panels/image-jobs-panel.js";

vi.mock("../session-context.js", () => ({
  useActiveSessionId: () => "session",
}));
vi.mock("@/lib/media-resolve.js", () => ({
  resolveMediaSrc: vi.fn(async () => ({
    ok: true,
    url: "https://example.test/media",
    fromCache: false,
  })),
}));
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each([
  ["en-US", "No media yet.", "No jobs yet."],
  ["zh-CN", "暂无媒体。", "暂无任务。"],
])(
  "uses neutral empty text in %s and honors authored overrides",
  async (locale, media, jobs) => {
    await i18n.changeLanguage(locale);
    const gallery = render(<MediaGalleryPanel props={{ items: [] }} />);
    expect(screen.getByText(media)).toBeTruthy();
    gallery.rerender(
      <MediaGalleryPanel
        props={{ items: [], emptyText: { [locale]: "Custom empty" } }}
      />,
    );
    expect(screen.getByText("Custom empty")).toBeTruthy();
    const list = render(<JobListPanel props={{ items: [] }} />);
    expect(screen.getByText(jobs)).toBeTruthy();
    list.rerender(
      <JobListPanel
        props={{ items: [], emptyText: { [locale]: "Custom jobs" } }}
      />,
    );
    expect(screen.getByText("Custom jobs")).toBeTruthy();
  },
);

it.each([
  ["image/jpeg", "img", "jpg"],
  ["audio/mpeg", "audio", "mp3"],
  ["video/webm", "video", "webm"],
  ["application/x-unknown", "a", "bin"],
])(
  "previews and downloads %s with its own format",
  async (mime, tag, extension) => {
    const filenames: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      filenames.push(this.download);
    });
    const { container } = render(
      <MediaGalleryPanel
        props={{
          items: [{ id: "asset", ref: { id: "a".repeat(64), mime, size: 1 } }],
        }}
      />,
    );
    await waitFor(() => expect(container.querySelector(tag)).not.toBeNull());
    if (tag !== "img")
      expect(container.querySelector(tag)?.closest("button")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(filenames).toEqual([`asset.${extension}`]));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.querySelector(tag)).not.toBeNull());
    fireEvent.click(within(dialog).getByRole("button", { name: "Download" }));
    await waitFor(() =>
      expect(filenames).toEqual([`asset.${extension}`, `media.${extension}`]),
    );
  },
);
