import { StrictMode, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/index.js";
import { Reveal } from "../Reveal.js";
import { admitCommittedStory } from "../committed-stories.js";
import {
  StoryRevealProvider,
  useStoryReveal,
} from "../story-reveal-context.js";
const preference = vi.hoisted(() => ({ instant: false, reduced: false }));
vi.mock("@/settings/use-settings.js", () => ({
  useSetting: () => [preference.instant],
}));
vi.mock("@/hooks/use-media-query.js", () => ({
  useMediaQuery: () => preference.reduced,
}));
beforeEach(async () => {
  vi.useFakeTimers();
  preference.instant = false;
  preference.reduced = false;
  await i18n.changeLanguage("en-US");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const children = [
  <p key="a">**Whole** first paragraph.</p>,
  <p key="b">Second paragraph.</p>,
  <p key="c">Third paragraph.</p>,
];
const hidden = () =>
  document.querySelectorAll('[data-reveal-hidden="true"]').length;
const group = (
  key: string,
  props: Partial<Parameters<typeof Reveal>[0]> = {},
  units: ReactNode = children,
) => (
  <Reveal revealKey={key} mode="segments" {...props}>
    {units}
  </Reveal>
);
function start(
  props: Partial<Parameters<typeof Reveal>[0]> = {},
  units: ReactNode = children,
) {
  const view = render(group("history", props, units));
  view.rerender(group("fresh", props, units));
  return view;
}
describe("complete-unit reveal", () => {
  it("defaults to instant and never animates initial history", () => {
    const view = render(group("history"));
    expect(hidden()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    view.rerender(<Reveal revealKey="default">{children}</Reveal>);
    expect(hidden()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("shows the first unit immediately and the complete semantic content once", () => {
    start();
    expect(hidden()).toBe(2);
    expect(screen.getAllByText("Second paragraph.")).toHaveLength(1);
    expect(
      screen.getByText("Third paragraph.").closest('[aria-live="off"]'),
    ).not.toBeNull();
    act(() => vi.advanceTimersByTime(120));
    expect(hidden()).toBe(1);
    act(() => vi.advanceTimersByTime(120));
    expect(hidden()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("compresses long groups into a maximum two second delay", () => {
    const units = Array.from({ length: 101 }, (_, index) => (
      <p key={index}>Paragraph {index}</p>
    ));
    start({ intervalMs: 500 }, units);
    expect(hidden()).toBe(100);
    act(() => vi.advanceTimersByTime(2000));
    expect(hidden()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not extend the deadline or hide visible blocks when a policy changes", () => {
    const units = Array.from({ length: 10 }, (_, index) => (
      <p key={index}>Block {index}</p>
    ));
    const view = start({ intervalMs: 120 }, units);
    act(() => vi.advanceTimersByTime(1000));
    const remaining = hidden();
    view.rerender(group("fresh", { intervalMs: 500 }, units));
    expect(hidden()).toBeLessThanOrEqual(remaining);
    act(() => vi.advanceTimersByTime(1000));
    expect(hidden()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["preference", "motion", "hidden", "inactive", "zero"])(
    "finishes immediately for %s and never resumes",
    (condition) => {
      const view = start();
      expect(hidden()).toBe(2);
      if (condition === "preference") preference.instant = true;
      if (condition === "motion") preference.reduced = true;
      if (condition === "hidden") {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        act(() => document.dispatchEvent(new Event("visibilitychange")));
      }
      view.rerender(
        group(
          "fresh",
          condition === "inactive"
            ? { active: false }
            : condition === "zero"
              ? { intervalMs: 0 }
              : {},
        ),
      );
      expect(hidden()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      preference.instant = false;
      preference.reduced = false;
      view.rerender(group("fresh"));
      expect(hidden()).toBe(0);
    },
  );
  it("finishes a mounted group when its panel becomes hidden", async () => {
    const view = render(<div>{group("history")}</div>);
    view.rerender(<div>{group("new")}</div>);
    expect(hidden()).toBe(2);
    await act(async () => view.rerender(<div hidden>{group("new")}</div>));
    expect(hidden()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    view.rerender(<div>{group("new")}</div>);
    expect(hidden()).toBe(0);
  });
  it("provides a native Show all button and cancels its timer", () => {
    start();
    const button = screen.getByRole("button", { name: "Show all" });
    expect(button.getAttribute("type")).toBe("button");
    fireEvent.click(button);
    expect(hidden()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps a focused Show all control in place until the player leaves it", () => {
    start();
    const button = screen.getByRole("button", { name: "Show all" });
    act(() => button.focus());
    fireEvent.click(button);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(hidden()).toBe(0);
    act(() => button.blur());
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
  });
  it("never delays actionable descendants, including whole Markdown links", () => {
    start({}, [
      <p key="text">Display</p>,
      <div key="action">
        <button type="button">Act now</button>
      </div>,
      <div key="link">
        <a href="#destination">Complete link</a>
      </div>,
    ]);
    expect(
      screen
        .getByRole("button", { name: "Act now" })
        .closest("[data-reveal-unit]")
        ?.getAttribute("data-reveal-hidden"),
    ).toBe("false");
    expect(
      screen
        .getByRole("link")
        .closest("[data-reveal-unit]")
        ?.getAttribute("data-reveal-hidden"),
    ).toBe("false");
  });
  it("replaces content authoritatively and cancels old timers on unmount", () => {
    const view = start();
    view.rerender(
      group("fresh", { revision: "replacement" }, [
        <p key="new">Replacement whole content</p>,
        <p key="tail">Replacement tail</p>,
      ]),
    );
    expect(hidden()).toBe(0);
    expect(screen.queryByText("Second paragraph.")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    view.rerender(group("another"));
    expect(hidden()).toBe(2);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
const message = (id: string) => ({
  id,
  content: id,
  segments: [{ kind: "narration", text: id }],
});
function Story({
  value,
  showsDrafts = false,
}: {
  value: ReturnType<typeof message>;
  showsDrafts?: boolean;
}) {
  const admission = useStoryReveal(value, { showsDrafts });
  return (
    <Reveal revealKey={value.id} {...admission} mode="segments">
      {children}
    </Reveal>
  );
}
function Visit({
  values,
  show = true,
  showsDrafts = false,
}: {
  values: ReturnType<typeof message>[];
  show?: boolean;
  showsDrafts?: boolean;
}) {
  return (
    <StoryRevealProvider sessionId="test" messages={values}>
      {show &&
        values.map((value) => (
          <Story key={value.id} value={value} showsDrafts={showsDrafts} />
        ))}
    </StoryRevealProvider>
  );
}
describe("live committed admission", () => {
  it("animates only live delivery and flushes an older group for the next message", () => {
    const first = message("first"),
      next = message("next"),
      last = message("last");
    const view = render(
      <StrictMode>
        <Visit values={[first]} />
      </StrictMode>,
    );
    expect(hidden()).toBe(0);
    act(() => admitCommittedStory("test", next));
    view.rerender(
      <StrictMode>
        <Visit values={[first, next]} />
      </StrictMode>,
    );
    expect(hidden()).toBe(2);
    act(() => admitCommittedStory("test", next));
    view.rerender(
      <StrictMode>
        <Visit values={[first, { ...next }]} />
      </StrictMode>,
    );
    expect(hidden()).toBe(2);
    act(() => admitCommittedStory("test", last));
    view.rerender(
      <StrictMode>
        <Visit values={[first, next, last]} />
      </StrictMode>,
    );
    expect(hidden()).toBe(2);
    act(() => vi.advanceTimersByTime(240));
    expect(hidden()).toBe(0);
  });
  it("renders a same-ID committed replacement instantly and cancels its old clock", () => {
    const first = message("first"),
      next = message("next");
    const view = render(<Visit values={[first]} />);
    act(() => admitCommittedStory("test", next));
    view.rerender(<Visit values={[first, next]} />);
    expect(hidden()).toBe(2);
    const replacement = { ...next, content: "Authoritative replacement" };
    act(() => admitCommittedStory("test", replacement));
    view.rerender(<Visit values={[first, replacement]} />);
    expect(hidden()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(2000));
    expect(hidden()).toBe(0);
  });
  it("never reanimates remount, recovery or inactive-view delivery", () => {
    const first = message("first"),
      next = message("next"),
      restored = message("restored");
    const view = render(<Visit values={[first]} />);
    act(() => admitCommittedStory("test", next));
    view.rerender(<Visit values={[first, next]} />);
    expect(hidden()).toBe(2);
    view.rerender(<Visit values={[first, next]} show={false} />);
    expect(vi.getTimerCount()).toBe(0);
    view.rerender(<Visit values={[first, next, restored]} />);
    expect(hidden()).toBe(0);
    view.rerender(<Visit values={[first]} show={false} />);
    const inactive = message("inactive");
    act(() => admitCommittedStory("test", inactive));
    view.rerender(<Visit values={[first, inactive]} show={false} />);
    view.rerender(<Visit values={[first, inactive]} />);
    expect(hidden()).toBe(0);
  });
  it("does not replay a story read as a draft where drafts are shown", () => {
    const first = message("first"),
      next = message("next");
    for (const showsDrafts of [true, false]) {
      const view = render(<Visit values={[first]} showsDrafts={showsDrafts} />);
      act(() => admitCommittedStory("test", next, true));
      view.rerender(<Visit values={[first, next]} showsDrafts={showsDrafts} />);
      // A surface without drafts still reveals it as a new story.
      expect(hidden()).toBe(showsDrafts ? 0 : 2);
      view.unmount();
    }
  });
});
