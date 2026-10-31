import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaRef } from "@covel/shared";
import {
  resolveMediaSrc,
  type ResolveOptions,
  type ResolveResult,
} from "@/lib/media-resolve.js";
import { StageSprites, type StageSpritesProps } from "../StageSprites.js";
import type { StageSpeaker, StageTransition } from "../stage-selectors.js";

vi.hoisted(() => {
  if (!window.AnimationEvent)
    Object.defineProperty(window, "AnimationEvent", {
      configurable: true,
      value: window.Event,
    });
});
vi.mock("@/hooks/use-media-query.js", () => ({ useMediaQuery: () => false }));
// Keep Media's loading state, effect lifetime and blob ownership real. Any
// accidental remount must wait at the same asynchronous resolution boundary.
vi.mock("@/lib/media-resolve.js", () => ({ resolveMediaSrc: vi.fn() }));

const resolutions: {
  options: ResolveOptions;
  resolve: (result: ResolveResult) => void;
}[] = [];
const revokeObjectURL = vi.fn();
const originalRevokeObjectURL = URL.revokeObjectURL;
const portrait: MediaRef = { id: "portrait", mime: "image/png", size: 1 };
const portraitUrl = "blob:stage-portrait";
const base: StageSpritesProps = {
  sessionId: "one",
  speakers: [],
  presence: { B: { characterId: "B", avatar: portrait } },
  retainWhenEmpty: false,
};
const sprite = () =>
  document.querySelector<HTMLElement>('[data-character-id="B"]');

beforeEach(() => {
  vi.useFakeTimers();
  resolutions.length = 0;
  revokeObjectURL.mockClear();
  URL.revokeObjectURL = revokeObjectURL;
  vi.mocked(resolveMediaSrc).mockReset();
  vi.mocked(resolveMediaSrc).mockImplementation(
    (_ref, options) =>
      new Promise((resolve) => resolutions.push({ options, resolve })),
  );
});
afterEach(() => {
  cleanup();
  URL.revokeObjectURL = originalRevokeObjectURL;
  vi.useRealTimers();
});

const departures: {
  name: string;
  entrance: StageTransition;
  exit?: StageTransition;
  deadline: number;
  animation: string;
}[] = [
  {
    name: "inferred fade",
    entrance: "fade",
    deadline: 350,
    animation: "ui-stage-fade-out",
  },
  {
    name: "inferred fade after a slide entrance",
    entrance: "slide-right",
    deadline: 350,
    animation: "ui-stage-fade-out",
  },
  {
    name: "explicit dissolve through committed omission",
    entrance: "slide-right",
    exit: "dissolve",
    deadline: 410,
    animation: "ui-stage-dissolve-out",
  },
];

describe.each(["animation", "deadline"] as const)(
  "stage portrait departure until %s cleanup",
  (completion) => {
    it.each(departures)(
      "keeps the loaded image mounted during $name",
      async ({ entrance, exit, deadline, animation }) => {
        const speaker: StageSpeaker = {
          id: "B",
          name: "B",
          transition: entrance,
        };
        const { rerender } = render(
          <StageSprites {...base} speakers={[speaker]} />,
        );
        expect(screen.getByRole("img").getAttribute("aria-busy")).toBe("true");
        expect(resolutions).toHaveLength(1);
        const initial = resolutions[0]!;
        expect(initial.options.sessionId).toBe("one");
        await act(async () => {
          initial.resolve({ url: portraitUrl, fromCache: true, ok: true });
        });
        const loaded = screen.getByAltText("B");
        const mounted = sprite()!;
        expect(loaded.tagName).toBe("IMG");
        fireEvent.load(loaded);

        if (exit) {
          rerender(
            <StageSprites
              {...base}
              speakers={[{ ...speaker, exiting: true, transition: exit }]}
            />,
          );
        } else {
          rerender(<StageSprites {...base} presence={{}} />);
        }

        const expectLoadedDeparture = () => {
          expect(sprite()).toBe(mounted);
          expect(mounted.dataset.phase).toBe("exit");
          expect(mounted.dataset.transition).toBe(exit ?? "fade");
          expect(mounted.querySelector("img")).toBe(loaded);
          expect(loaded.getAttribute("src")).toBe(portraitUrl);
          expect(loaded.isConnected).toBe(true);
          expect(mounted.querySelector('[aria-busy="true"]')).toBeNull();
          // Every subsequent resolution remains deferred past the deadline.
          expect(resolveMediaSrc).toHaveBeenCalledTimes(1);
          expect(initial.options.signal?.aborted).toBe(false);
          expect(revokeObjectURL).not.toHaveBeenCalled();
        };
        expectLoadedDeparture();
        act(() => vi.advanceTimersByTime(100));
        if (exit) rerender(<StageSprites {...base} presence={{}} />);
        expectLoadedDeparture();
        act(() => vi.advanceTimersByTime(deadline - 101));
        expectLoadedDeparture();

        if (completion === "animation") {
          const event = new Event("animationend", { bubbles: true });
          Object.defineProperty(event, "animationName", { value: animation });
          fireEvent(mounted, event);
        } else {
          act(() => vi.advanceTimersByTime(1));
        }
        expect(sprite()).toBeNull();
        expect(loaded.isConnected).toBe(false);
        expect(initial.options.signal?.aborted).toBe(true);
        expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(portraitUrl);
        expect(vi.getTimerCount()).toBe(0);
      },
    );
  },
);
