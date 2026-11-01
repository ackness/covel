import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaRef } from "@covel/shared";
import { StageSprites, type StageSpritesProps } from "../StageSprites.js";
import type { StageSpeaker, StageTransition } from "../stage-selectors.js";

const motion = vi.hoisted(() => {
  // React checks animation-event support when it initializes event delegation.
  if (!window.AnimationEvent)
    Object.defineProperty(window, "AnimationEvent", {
      configurable: true,
      value: window.Event,
    });
  return { reduce: false };
});
vi.mock("@/hooks/use-media-query.js", () => ({
  useMediaQuery: () => motion.reduce,
}));
vi.mock("@/components/Media.js", () => ({
  Media: ({
    src,
    sessionId,
    alt,
  }: {
    src: MediaRef;
    sessionId: string;
    alt: string;
  }) => <img src={src.id} alt={alt} data-session={sessionId} />,
}));

beforeEach(() => {
  vi.useFakeTimers();
  motion.reduce = false;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const cast = (...ids: string[]): StageSpeaker[] =>
  ids.map((id) => ({ id, name: id }));
const base: StageSpritesProps = {
  sessionId: "one",
  speakers: [],
  presence: {},
  retainWhenEmpty: false,
  exitTransition: "fade",
};
const sprite = (id: string) =>
  document.querySelector<HTMLElement>(
    `.ui-stage-sprite[data-character-id="${id}"]`,
  );
function end(node: HTMLElement, animationName = "ui-stage-fade-out") {
  const event = new Event("animationend", { bubbles: true });
  Object.defineProperty(event, "animationName", { value: animationName });
  fireEvent(node, event);
}
const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

describe("stage sprite departures", () => {
  it.each([undefined, "none"] as const)(
    "cuts inferred disappearance with policy %s while explicit exits keep their transition",
    (exitTransition) => {
      const props = { ...base, exitTransition };
      const { rerender } = render(
        <StageSprites {...props} speakers={cast("A", "B")} />,
      );
      rerender(<StageSprites {...props} speakers={cast("A")} />);
      expect(sprite("B")).toBeNull();
      rerender(
        <StageSprites
          {...props}
          speakers={[
            { id: "A", name: "A", exiting: true, transition: "dissolve" },
          ]}
        />,
      );
      expect(sprite("A")!.dataset.transition).toBe("dissolve");
      rerender(<StageSprites {...props} />);
      advance(409);
      expect(sprite("A")).not.toBeNull();
      advance(1);
      expect(sprite("A")).toBeNull();
    },
  );

  it("clears only inferred departures when policy switches off", () => {
    const { rerender } = render(
      <StageSprites {...base} speakers={cast("A", "B", "C")} />,
    );
    const speakers: StageSpeaker[] = [
      { id: "A", name: "A" },
      { id: "B", name: "B", exiting: true, transition: "slide-left" },
    ];
    rerender(<StageSprites {...base} speakers={speakers} />);
    expect(sprite("C")!.dataset.phase).toBe("exit");
    advance(100);
    rerender(
      <StageSprites {...base} speakers={speakers} exitTransition="none" />,
    );
    expect(sprite("C")).toBeNull();
    expect(sprite("B")!.dataset.transition).toBe("slide-left");
    advance(269);
    expect(sprite("B")).not.toBeNull();
    advance(1);
    expect(sprite("B")).toBeNull();
  });

  it("cuts ambiguous keys without retaining the previous cast", () => {
    const { rerender } = render(
      <StageSprites {...base} speakers={cast("A", "B")} />,
    );
    rerender(<StageSprites {...base} speakers={cast("C", "C", "")} />);
    expect(document.querySelectorAll('[data-phase="present"]')).toHaveLength(3);
    expect(document.querySelectorAll('[data-phase="exit"]')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the last displayed portrait and lane until its own fade completes without another update", () => {
    const portrait = { id: "old-portrait", mime: "image/png", size: 1 };
    const presence = { B: { characterId: "B", avatar: portrait } };
    const { rerender } = render(
      <StageSprites {...base} speakers={cast("A", "B")} presence={presence} />,
    );
    const lane = sprite("B")!.style.left;
    rerender(<StageSprites {...base} speakers={cast("A")} />);
    const departing = sprite("B")!;
    expect(departing.dataset.phase).toBe("exit");
    expect(departing.dataset.transition).toBe("fade");
    expect(departing.getAttribute("aria-hidden")).toBe("true");
    expect(departing.hasAttribute("inert")).toBe(true);
    expect(departing.style.zIndex).toBe("0");
    expect(departing.style.left).toBe(lane);
    expect(screen.getByAltText("B").getAttribute("src")).toBe("old-portrait");
    end(departing.querySelector(".ui-stage-visual")!);
    end(departing, "ui-stage-rise-in");
    expect(sprite("B")).toBe(departing);
    end(departing);
    expect(sprite("B")).toBeNull();
    expect(sprite("A")!.dataset.phase).toBe("present");
  });

  it("autonomously removes a fallback standee when animation events are lost", () => {
    const { rerender } = render(
      <StageSprites {...base} speakers={cast("A", "B")} />,
    );
    rerender(<StageSprites {...base} speakers={cast("A")} />);
    expect(
      sprite("B")!.querySelector(".ui-stage-sprite-fallback")!.textContent,
    ).toBe("B");
    advance(349);
    expect(sprite("B")).not.toBeNull();
    advance(1);
    expect(sprite("B")).toBeNull();
  });

  it.each([
    "none",
    "slide-left",
    "slide-right",
    "fade",
    "dissolve",
  ] satisfies StageTransition[])(
    "honors explicit %s once through duplicate previews and committed omission",
    (transition) => {
      const { rerender } = render(
        <StageSprites {...base} speakers={cast("B")} />,
      );
      const preview = [{ ...cast("B")[0]!, exiting: true, transition }];
      rerender(<StageSprites {...base} speakers={preview} retainWhenEmpty />);
      if (transition === "none") expect(sprite("B")).toBeNull();
      else expect(sprite("B")!.dataset.transition).toBe(transition);
      advance(200);
      rerender(
        <StageSprites {...base} speakers={[...preview]} retainWhenEmpty />,
      );
      rerender(<StageSprites {...base} />);
      advance(220);
      expect(sprite("B")).toBeNull();
      rerender(<StageSprites {...base} speakers={[...preview]} />);
      rerender(<StageSprites {...base} retainWhenEmpty />);
      expect(sprite("B")).toBeNull();
    },
  );

  it("ignores a remembered entrance instruction for an inferred departure", () => {
    const { rerender } = render(
      <StageSprites
        {...base}
        speakers={[{ id: "B", name: "B", transition: "slide-right" }]}
      />,
    );
    rerender(<StageSprites {...base} />);
    expect(sprite("B")!.dataset.transition).toBe("fade");
  });

  it("lays out four live actors independently of the outgoing actor", () => {
    const { rerender, unmount } = render(
      <StageSprites {...base} speakers={cast("A", "B", "C", "D")} />,
    );
    const oldLane = sprite("D")!.style.cssText;
    rerender(<StageSprites {...base} speakers={cast("A", "B", "C", "E")} />);
    expect(document.querySelectorAll(".ui-stage-sprite")).toHaveLength(5);
    expect(sprite("D")!.style.left).toBe("75%");
    expect(oldLane).toContain("left: 75%");
    const lanes = ["A", "B", "C", "E"].map((id) => [
      sprite(id)!.style.left,
      sprite(id)!.style.width,
    ]);
    end(sprite("D")!);
    expect(document.querySelectorAll(".ui-stage-sprite")).toHaveLength(4);
    unmount();
    render(<StageSprites {...base} speakers={cast("A", "B", "C", "E")} />);
    expect(
      ["A", "B", "C", "E"].map((id) => [
        sprite(id)!.style.left,
        sprite(id)!.style.width,
      ]),
    ).toEqual(lanes);
  });

  it("bounds overlapping departures at four while retaining every current actor", () => {
    const { rerender } = render(
      <StageSprites {...base} speakers={cast("A", "B", "C", "D")} />,
    );
    rerender(<StageSprites {...base} speakers={cast("E", "F", "G", "H")} />);
    expect(document.querySelectorAll(".ui-stage-sprite")).toHaveLength(8);
    rerender(<StageSprites {...base} speakers={cast("I", "F", "G", "H")} />);
    expect(document.querySelectorAll('[data-phase="exit"]')).toHaveLength(4);
    expect(sprite("A")).toBeNull();
    for (const id of ["I", "F", "G", "H"])
      expect(sprite(id)!.dataset.phase).toBe("present");
  });

  it("cancels an exit on re-entry and ignores its stale completion and deadline", () => {
    const { rerender } = render(
      <StageSprites {...base} speakers={cast("B")} />,
    );
    rerender(<StageSprites {...base} />);
    const old = sprite("B")!;
    advance(100);
    rerender(<StageSprites {...base} speakers={cast("B")} />);
    end(old);
    advance(500);
    expect(document.querySelectorAll('[data-character-id="B"]')).toHaveLength(
      1,
    );
    expect(sprite("B")!.dataset.phase).toBe("present");
  });

  it("does not renew deadlines on focus, media or unchanged snapshot updates", () => {
    const { rerender } = render(
      <StageSprites {...base} speakers={cast("A", "B")} />,
    );
    rerender(<StageSprites {...base} speakers={cast("A")} />);
    advance(200);
    rerender(
      <StageSprites
        {...base}
        speakers={[{ id: "A", name: "A", active: false }]}
        presence={{}}
        dimmed
      />,
    );
    advance(150);
    expect(sprite("B")).toBeNull();
  });

  it("retains only a transitional empty lineup and clears an authoritative empty once", () => {
    const { rerender } = render(
      <StageSprites {...base} speakers={cast("B")} />,
    );
    rerender(<StageSprites {...base} retainWhenEmpty />);
    expect(sprite("B")!.dataset.phase).toBe("present");
    expect(
      sprite("B")!.querySelector(".ui-stage-sprite-inactive"),
    ).not.toBeNull();
    rerender(<StageSprites {...base} />);
    expect(sprite("B")!.dataset.phase).toBe("exit");
    advance(500);
    rerender(<StageSprites {...base} retainWhenEmpty />);
    expect(sprite("B")).toBeNull();
  });

  it("drops all previous session pixels and cancels their timers", () => {
    const { rerender } = render(
      <StageSprites {...base} speakers={cast("A", "B")} />,
    );
    rerender(<StageSprites {...base} speakers={cast("A")} />);
    rerender(<StageSprites {...base} sessionId="two" speakers={cast("B")} />);
    expect(sprite("A")).toBeNull();
    expect(sprite("B")!.style.left).toBe("20%");
    advance(500);
    expect(sprite("B")!.dataset.phase).toBe("present");
  });

  it("cuts departures immediately with reduced motion, including a preference change", () => {
    const { rerender } = render(
      <StageSprites {...base} speakers={cast("A", "B")} />,
    );
    rerender(<StageSprites {...base} speakers={cast("A")} />);
    motion.reduce = true;
    rerender(<StageSprites {...base} speakers={cast("A")} />);
    expect(sprite("B")).toBeNull();
    rerender(<StageSprites {...base} />);
    expect(sprite("A")).toBeNull();
  });

  it("keeps StrictMode exits singular and clears every timer on unmount", () => {
    const { rerender, unmount } = render(
      <StrictMode>
        <StageSprites {...base} speakers={cast("A", "B")} />
      </StrictMode>,
    );
    rerender(
      <StrictMode>
        <StageSprites {...base} speakers={cast("A")} />
      </StrictMode>,
    );
    expect(document.querySelectorAll('[data-phase="exit"]')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    render(<StageSprites {...base} speakers={cast("B")} />);
    advance(500);
    expect(sprite("B")!.dataset.phase).toBe("present");
  });
});
