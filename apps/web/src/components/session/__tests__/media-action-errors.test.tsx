import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { emitToast } from "@/lib/toast-channel.js";
import { resolveMediaSrc } from "@/lib/media-resolve.js";
import { downloadImage } from "../image-plugin-panels/actions.js";
import { JobListPanel } from "../image-plugin-panels/image-jobs-panel.js";

vi.mock("@/lib/toast-channel.js", () => ({ emitToast: vi.fn() }));
vi.mock("@/lib/media-resolve.js", () => ({ resolveMediaSrc: vi.fn() }));
afterEach(async () => {
  cleanup();
  vi.resetAllMocks();
  await i18n.changeLanguage("zh-CN");
});

it.each(["zh-CN", "en-US", "ru-RU"])(
  "translates missing session and media errors in %s",
  async (locale) => {
    await i18n.changeLanguage(locale);
    const args = {
      ref: { id: "a".repeat(64), mime: "image/png", size: 1 },
      filename: "picture.png",
      t: i18n.t,
    };
    downloadImage({ ...args, sessionId: undefined });
    await waitFor(() =>
      expect(emitToast).toHaveBeenLastCalledWith(
        "error",
        i18n.t("coreImage.sessionUnavailable"),
      ),
    );
    vi.mocked(resolveMediaSrc).mockResolvedValue({
      ok: false,
      url: "",
      fromCache: false,
    });
    downloadImage({ ...args, sessionId: "session" });
    await waitFor(() =>
      expect(emitToast).toHaveBeenLastCalledWith(
        "error",
        i18n.t("coreImage.mediaUnavailable"),
      ),
    );
  },
);

it.each([
  "queued",
  "running",
  "progress",
  "waiting-input",
  "succeeded",
  "failed",
  "cancelled",
])(
  "translates the host job state %s and keeps Error details readable",
  (status) => {
    render(
      <JobListPanel
        props={{
          items: [
            { jobId: "job", status, error: new Error("Provider detail") },
          ],
        }}
      />,
    );
    const button = screen.getByRole("button", {
      name: new RegExp(i18n.t(`session.jobStatus.${status}`)),
    });
    expect(button).toBeTruthy();
    // Pending jobs start expanded; other states can be inspected on demand.
    if (!screen.queryByText("Provider detail")) fireEvent.click(button);
    expect(screen.getByText("Provider detail")).toBeTruthy();
    expect(screen.queryByText("Error: Provider detail")).toBeNull();
  },
);
