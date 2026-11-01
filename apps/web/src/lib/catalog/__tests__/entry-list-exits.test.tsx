import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { JSONUIProvider, Renderer, createStateStore } from "@json-render/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { covelRegistry } from "../../catalog.js";
import { pluginPanelViewToSpec } from "../../plugin-panel-spec.js";

const context = vi.hoisted(() => {
  if (!window.AnimationEvent)
    Object.defineProperty(window, "AnimationEvent", {
      configurable: true,
      value: window.Event,
    });
  return { sessionId: "one", listeners: new Set<() => void>() };
});
vi.mock("../session-context.js", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useActiveSessionId: () =>
      useSyncExternalStore(
        (listener) => {
          context.listeners.add(listener);
          return () => {
            context.listeners.delete(listener);
          };
        },
        () => context.sessionId,
      ),
  };
});
let reduce = false;
const motionListeners = new Set<() => void>();
beforeEach(() => {
  vi.useFakeTimers();
  context.sessionId = "one";
  reduce = false;
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return reduce;
    },
    addEventListener: (_event: string, listener: () => void) =>
      motionListeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) =>
      motionListeners.delete(listener),
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const row = (id: string, title = id) => ({ id, title, body: `body ${title}` });
const rows = (phase: string) =>
  document.querySelectorAll(`.ui-entry-row[data-phase="${phase}"]`);
const node = (title: string) =>
  screen.getByText(title).closest<HTMLElement>(".ui-entry-row")!;
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
function end(element: Element, animationName = "ui-keyed-fade-out") {
  const event = new Event("animationend", { bubbles: true });
  Object.defineProperty(event, "animationName", { value: animationName });
  fireEvent(element, event);
}
function mount(
  entries: unknown[],
  policy: "none" | "fade" | undefined = "fade",
  strict = false,
) {
  const store = createStateStore({ entries });
  let identity = "list";
  let titleField: string | undefined = "title";
  const content = () => {
    const spec = pluginPanelViewToSpec({
      component: "EntryList",
      props: {
        items: { $state: "/entries" },
        idField: "id",
        titleField,
        descriptionFields: ["body"],
        ...(policy ? { exitTransition: policy } : {}),
      },
    })!;
    return (
      <JSONUIProvider registry={covelRegistry} store={store}>
        <Renderer key={identity} spec={spec} registry={covelRegistry} />
      </JSONUIProvider>
    );
  };
  const root = () =>
    strict ? <StrictMode>{content()}</StrictMode> : content();
  const rendered = render(root());
  return {
    ...rendered,
    set: (items: unknown[]) => act(() => store.set("/entries", items)),
    policy: (next: "none" | "fade" | undefined) => {
      policy = next;
      rendered.rerender(root());
    },
    valid: (enabled: boolean) => {
      titleField = enabled ? "title" : undefined;
      rendered.rerender(root());
    },
    replace: () => {
      identity = "replacement";
      rendered.rerender(root());
    },
  };
}

describe("EntryList keyed departures through the catalog", () => {
  it("keeps previous row content inert and outside current layout until its own animation ends", () => {
    const list = mount([row("A"), row("B", "Old title")]);
    const before = node("Old title");
    Object.defineProperty(before, "offsetTop", { value: 48 });
    list.set([row("A"), row("C", "New title")]);
    expect(rows("present")).toHaveLength(2);
    expect(node("New title").dataset.phase).toBe("present");
    const outgoing = node("Old title");
    expect(outgoing).toBe(before);
    expect(outgoing.textContent).toContain("body Old title");
    expect(outgoing.getAttribute("aria-hidden")).toBe("true");
    expect(outgoing.hasAttribute("inert")).toBe(true);
    expect(outgoing.classList.contains("ui-keyed-exit")).toBe(true);
    expect(outgoing.style.top).toBe("48px");
    expect(outgoing.parentElement!.classList.contains("overflow-hidden")).toBe(
      false,
    );
    expect(outgoing.querySelectorAll("button,input,a,[tabindex]")).toHaveLength(
      0,
    );
    end(outgoing.firstElementChild!);
    end(outgoing, "ui-pulse");
    expect(rows("exit")).toHaveLength(1);
    end(outgoing);
    expect(rows("exit")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires locally without animation events and never renews an unchanged snapshot deadline", () => {
    const list = mount([row("A"), row("B")]);
    list.set([row("A")]);
    advance(200);
    list.set([row("A", "fresh A")]);
    advance(149);
    expect(node("B").dataset.phase).toBe("exit");
    advance(1);
    expect(screen.queryByText("B")).toBeNull();
    expect(node("fresh A").dataset.phase).toBe("present");
  });

  it("reorders immediately, cancels re-entry with fresh content and ignores old completion/deadline callbacks", () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    const list = mount([row("A"), row("B")]);
    list.set([row("B"), row("A")]);
    expect([...rows("present")].map((entry) => entry.textContent)).toEqual([
      "Bbody B",
      "Abody A",
    ]);
    expect(rows("exit")).toHaveLength(0);
    list.set([row("A")]);
    const outgoing = node("B");
    const staleDeadline = timer.mock.calls.at(-1)![0] as () => void;
    advance(100);
    list.set([row("A"), row("B", "Returned")]);
    end(outgoing);
    act(() => staleDeadline());
    expect(screen.queryByText("B")).toBeNull();
    expect(node("Returned").dataset.phase).toBe("present");
    list.set([row("A")]);
    advance(250);
    act(() => staleDeadline());
    expect(node("Returned").dataset.phase).toBe("exit");
    advance(100);
    expect(screen.queryByText("Returned")).toBeNull();
    timer.mockRestore();
  });

  it.each(["none", undefined] as const)(
    "cuts removals when the policy is %s",
    (policy) => {
      const list = mount([row("A"), row("B")]);
      list.policy(policy);
      list.set([row("C")]);
      expect(rows("exit")).toHaveLength(0);
      expect(rows("present")).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("clears inferred exits on a policy change and handles authoritative empty lists once", () => {
    const list = mount([row("A"), row("B")]);
    list.set([]);
    expect(rows("exit")).toHaveLength(2);
    list.policy("none");
    expect(rows("exit")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    list.policy("fade");
    list.set([]);
    expect(rows("exit")).toHaveLength(0);
  });

  it("discards departures and timers when invalid props remove the list", () => {
    const list = mount([row("A"), row("B")]);
    list.set([row("A")]);
    list.valid(false);
    expect(rows("exit")).toHaveLength(0);
    expect(rows("present")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    list.valid(true);
    expect(rows("present")).toHaveLength(1);
    expect(screen.queryByText("B")).toBeNull();
    advance(500);
    expect(node("A").dataset.phase).toBe("present");
  });

  it.each([
    [{ title: "No key" }, row("A")],
    [row("A", "First A"), row("A", "Second A")],
    [row(" ", "Blank key")],
  ])(
    "cuts an ambiguous update without hiding any current rows: %j",
    (...items) => {
      const list = mount([row("old")]);
      list.set(items);
      expect(rows("present")).toHaveLength(items.length);
      expect(rows("exit")).toHaveLength(0);
      expect(screen.queryByText("old")).toBeNull();
      list.set([row("new")]);
      expect(rows("exit")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("evicts oldest departures at 32 without limiting current rows", () => {
    const list = mount(Array.from({ length: 40 }, (_, i) => row(`old ${i}`)));
    list.set(Array.from({ length: 40 }, (_, i) => row(`new ${i}`)));
    expect(rows("present")).toHaveLength(40);
    expect(rows("exit")).toHaveLength(32);
    expect(screen.queryByText("old 0")).toBeNull();
    expect(node("old 8").dataset.phase).toBe("exit");
    list.set([row("latest")]);
    expect(rows("exit")).toHaveLength(32);
    expect(screen.queryByText("old 8")).toBeNull();
    advance(350);
    expect(rows("exit")).toHaveLength(0);
  });

  it.each(["session", "list"])(
    "discards memory on %s identity replacement",
    (identity) => {
      const list = mount([row("A"), row("B")]);
      list.set([row("A")]);
      if (identity === "session")
        act(() => {
          context.sessionId = "two";
          for (const listener of context.listeners) listener();
        });
      else list.replace();
      expect(rows("exit")).toHaveLength(0);
      expect(rows("present")).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      advance(500);
      expect(node("A").dataset.phase).toBe("present");
    },
  );

  it("immediately clears exits on a live reduced-motion preference change", () => {
    const list = mount([row("A"), row("B")]);
    list.set([row("A")]);
    act(() => {
      reduce = true;
      for (const listener of motionListeners) listener();
    });
    expect(rows("exit")).toHaveLength(0);
    list.set([]);
    expect(rows("exit")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps StrictMode departures singular and cancels all timers on unmount", () => {
    const list = mount([row("A"), row("B")], "fade", true);
    list.set([row("A")]);
    expect(rows("exit")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    list.unmount();
    expect(vi.getTimerCount()).toBe(0);
    mount([row("B")]);
    advance(500);
    expect(node("B").dataset.phase).toBe("present");
  });
});
