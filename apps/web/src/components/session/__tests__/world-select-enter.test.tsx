/**
 * Entering a world must not depend on a frame being painted.
 *
 * The navigation used to be deferred to `requestAnimationFrame` so the busy
 * state could paint first. Browsers pause rAF while a page is hidden, so a
 * click on a backgrounded or throttled tab set the busy flag and then never
 * navigated — the card spun forever, every other card became
 * `pointer-events-none`, and nothing short of a reload recovered it.
 *
 * These tests stub rAF into a no-op to stand in for a hidden page: the first
 * one fails against the deferred implementation, the second pins the escape
 * hatch that keeps a failed navigation from stranding the grid.
 */

import { fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorldSelectScreen } from "../world-select-screen.js";
import type { WorldRecord } from "@/services/api.js";

const WORLDS = [
  {
    id: "haruka-academy",
    name: "遥风学园",
    description: "一所海边私立高中",
  } as WorldRecord,
];

function renderScreen(onSelectWorld: (id: string) => void) {
  return render(
    <WorldSelectScreen
      worlds={WORLDS}
      packages={[]}
      resolvedSlots={[]}
      settingsOpen={false}
      onSettingsOpenChange={() => {}}
      onSelectWorld={onSelectWorld}
    />,
  );
}

/** Stand in for a hidden page: rAF callbacks are registered and never run. */
function suspendAnimationFrames() {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
}

describe("world select — entering a world", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("navigates even when animation frames never fire", () => {
    suspendAnimationFrames();
    const onSelectWorld = vi.fn();
    renderScreen(onSelectWorld);

    fireEvent.click(screen.getByText("遥风学园"));

    expect(onSelectWorld).toHaveBeenCalledWith("haruka-academy");
  });

  it("releases the busy lock when the navigation does not take", () => {
    vi.useFakeTimers();
    suspendAnimationFrames();
    // A selection that goes nowhere — the screen stays mounted, which is the
    // exact state that used to be unrecoverable.
    const { container } = renderScreen(() => {});

    fireEvent.click(screen.getByText("遥风学园"));
    expect(container.querySelector('article[aria-busy="true"]')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(container.querySelector('article[aria-busy="true"]')).toBeNull();
  });
});
