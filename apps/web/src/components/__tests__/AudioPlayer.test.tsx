/**
 * Behavioural tests for `<AudioPlayer>` (plain DOM matchers — repo does
 * not install @testing-library/jest-dom).
 *
 * Covers the user-visible surface area:
 *   - Resolves a MediaRef → renders play/seek/speed/download chrome
 *   - Toggles play/pause when the button is clicked
 *   - Reflects timeupdate / loadedmetadata events in the readout + bar
 *   - Speed selector writes through to audio.playbackRate
 *   - Download anchor carries a sensible filename derived from MIME
 *   - Falls back to "audio unavailable" when ref is missing or fails
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AudioPlayer } from "../AudioPlayer.js";
import type { MediaRef } from "@covel/shared";

const FAKE_REF: MediaRef = {
  id: "sha256-deadbeef",
  mime: "audio/mpeg",
  size: 1024,
};

const RESOLVED_URL = "blob:fake-resolved";

vi.mock("../../lib/media-resolve.js", () => ({
  resolveMediaSrc: vi.fn(),
}));

const { resolveMediaSrc } = await import("../../lib/media-resolve.js");

beforeEach(() => {
  vi.mocked(resolveMediaSrc).mockResolvedValue({
    url: RESOLVED_URL,
    fromCache: true,
    ok: true,
  });

  // jsdom: stub play/pause + fire matching events ourselves.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, "paused", { configurable: true, value: false });
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, "paused", { configurable: true, value: true });
    this.dispatchEvent(new Event("pause"));
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AudioPlayer", () => {
  it("renders play / seek / speed / download chrome once the ref resolves", async () => {
    render(<AudioPlayer src={FAKE_REF} sessionId="sess" alt="narration" />);

    const playBtn = await screen.findByRole("button", { name: /play/i });
    await waitFor(() => expect(playBtn.hasAttribute("disabled")).toBe(false));

    expect(screen.getByRole("slider", { name: /seek/i })).toBeTruthy();
    expect(screen.getByLabelText(/playback speed/i)).toBeTruthy();
    const dl = screen.getByLabelText(/download audio/i) as HTMLAnchorElement;
    expect(dl.getAttribute("href")).toBe(RESOLVED_URL);
    expect(dl.getAttribute("download")).toBe("narration.mp3");
  });

  it("toggles between play and pause when the button is clicked", async () => {
    render(<AudioPlayer src={FAKE_REF} sessionId="sess" alt="narration" />);
    const playBtn = await screen.findByRole("button", { name: /play/i });
    await waitFor(() => expect(playBtn.hasAttribute("disabled")).toBe(false));

    fireEvent.click(playBtn);
    expect(screen.getByRole("button", { name: /pause/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /pause/i }));
    expect(screen.getByRole("button", { name: /play/i })).toBeTruthy();
  });

  it("updates the time readout + progress fill when audio events fire", async () => {
    const { container } = render(
      <AudioPlayer src={FAKE_REF} sessionId="sess" alt="x" />,
    );
    const playBtn = await screen.findByRole("button", { name: /play/i });
    await waitFor(() => expect(playBtn.hasAttribute("disabled")).toBe(false));

    const audio = container.querySelector("audio") as HTMLAudioElement;
    Object.defineProperty(audio, "duration", { configurable: true, value: 120 });
    act(() => {
      audio.dispatchEvent(new Event("loadedmetadata"));
    });
    Object.defineProperty(audio, "currentTime", {
      configurable: true,
      value: 30,
    });
    act(() => {
      audio.dispatchEvent(new Event("timeupdate"));
    });

    expect(screen.getByTestId("audio-time").textContent).toBe("0:30 / 2:00");
    const fill = screen.getByTestId("audio-progress-fill") as HTMLDivElement;
    expect(fill.style.width).toBe("25%");
  });

  it("writes the selected speed through to audio.playbackRate", async () => {
    const { container } = render(
      <AudioPlayer src={FAKE_REF} sessionId="sess" alt="x" />,
    );
    const playBtn = await screen.findByRole("button", { name: /play/i });
    await waitFor(() => expect(playBtn.hasAttribute("disabled")).toBe(false));

    const audio = container.querySelector("audio") as HTMLAudioElement;
    const speedSel = screen.getByLabelText(/playback speed/i) as HTMLSelectElement;

    fireEvent.change(speedSel, { target: { value: "1.5" } });
    expect(audio.playbackRate).toBe(1.5);

    fireEvent.change(speedSel, { target: { value: "0.75" } });
    expect(audio.playbackRate).toBe(0.75);
  });

  it("falls back to an unavailable tile when ref is missing", () => {
    const InvalidProps = { src: undefined, sessionId: "s" } as unknown as {
      src: MediaRef;
      sessionId: string;
    };
    render(<AudioPlayer {...InvalidProps} />);
    expect(screen.getByText(/audio unavailable/i)).toBeTruthy();
  });

  it("falls back to an unavailable tile when resolution fails", async () => {
    vi.mocked(resolveMediaSrc).mockResolvedValueOnce({
      url: "",
      fromCache: false,
      ok: false,
    });
    render(<AudioPlayer src={FAKE_REF} sessionId="s" alt="x" />);
    await waitFor(() =>
      expect(screen.getByText(/audio unavailable/i)).toBeTruthy(),
    );
  });

  it("derives a wav filename when the MIME is audio/wav", async () => {
    const wavRef: MediaRef = { ...FAKE_REF, mime: "audio/wav" };
    render(<AudioPlayer src={wavRef} sessionId="s" alt="clip" />);
    const dl = (await screen.findByLabelText(
      /download audio/i,
    )) as HTMLAnchorElement;
    await waitFor(() => expect(dl.getAttribute("download")).toBe("clip.wav"));
  });
});
