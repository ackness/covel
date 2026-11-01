import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/index.js";
import { Reveal } from "@/lib/reveal/Reveal.js";
import { useAutoScroll } from "../use-auto-scroll.js";

vi.mock("@/settings/use-settings.js", () => ({ useSetting: () => [false] }));
vi.mock("@/hooks/use-media-query.js", () => ({ useMediaQuery: () => false }));

function Harness({ message = false }: { message?: boolean }) {
  const { scrollRef, showJumpButton, jumpToBottom } = useAutoScroll(message);
  return (
    <>
      <div ref={scrollRef} data-testid="viewport">
        {message && (
          <Reveal
            revealKey="fresh"
            revision="fixed"
            mode="segments"
            intervalMs={500}
            live
          >
            <p data-top="500">First tall paragraph</p>
            <p data-top="1000">Second tall paragraph</p>
            <p data-top="1500">Third tall paragraph</p>
          </Reveal>
        )}
      </div>
      {showJumpButton && <button onClick={jumpToBottom}>Jump</button>}
    </>
  );
}

beforeEach(async () => {
  vi.useFakeTimers();
  await i18n.changeLanguage("en-US");
  // jsdom has no layout: model a 300px viewport and three 500px units.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(2000);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const viewport = screen.queryByTestId("viewport");
      const unit = this.querySelector<HTMLElement>("[data-top]");
      const top = this.hasAttribute("data-reveal-unit")
        ? 100 + Number(unit?.dataset.top) - (viewport?.scrollTop ?? 0)
        : 100;
      return {
        top,
        bottom: top + (unit ? 500 : 300),
        left: 0,
        right: 400,
        width: 400,
        height: unit ? 500 : 300,
        x: 0,
        y: top,
        toJSON() {},
      };
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(function (
      this: HTMLElement,
      options: ScrollToOptions | number,
    ) {
      if (typeof options === "object") this.scrollTop = options.top ?? 0;
      // Browser-generated scroll events must not unpin the reveal anchor.
      this.dispatchEvent(new Event("scroll"));
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

it("keeps the first tall revealed unit in view, follows ticks and resumes the full bottom", async () => {
  const view = render(<Harness />);
  const viewport = screen.getByTestId("viewport");
  expect(viewport.scrollTop).toBe(1700);
  await act(async () => view.rerender(<Harness message />));
  expect(viewport.scrollTop).toBe(500);
  expect(screen.queryByRole("button", { name: "Jump" })).toBeNull();
  await act(async () => vi.advanceTimersByTime(500));
  expect(viewport.scrollTop).toBe(1000);
  await act(async () => vi.advanceTimersByTime(500));
  expect(viewport.scrollTop).toBe(1700);
  expect(viewport.textContent).toContain("Third tall paragraph");
});

it("follows Show all while pinned and respects the player's scroll override", async () => {
  const view = render(<Harness />);
  await act(async () => view.rerender(<Harness message />));
  const viewport = screen.getByTestId("viewport");
  viewport.scrollTop = 100;
  fireEvent.scroll(viewport);
  expect(screen.getByRole("button", { name: "Jump" })).toBeTruthy();
  await act(async () => vi.advanceTimersByTime(500));
  expect(viewport.scrollTop).toBe(100);
  fireEvent.click(screen.getByRole("button", { name: "Jump" }));
  expect(viewport.scrollTop).toBe(1000);
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Show all" })),
  );
  expect(viewport.scrollTop).toBe(1700);
});

it("does not move a reader who has scrolled up when reveal finishes", async () => {
  const view = render(<Harness />);
  await act(async () => view.rerender(<Harness message />));
  const viewport = screen.getByTestId("viewport");
  viewport.scrollTop = 100;
  fireEvent.scroll(viewport);
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Show all" })),
  );
  expect(viewport.scrollTop).toBe(100);
  fireEvent.click(screen.getByRole("button", { name: "Jump" }));
  expect(viewport.scrollTop).toBe(1700);
});
