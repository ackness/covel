import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { covelRegistry } from "@/lib/catalog.js";
import { pluginPanelViewToSpec } from "@/lib/plugin-panel-spec.js";
import { StoryMessageBody } from "@/components/session/chat-messages/story-segments-body.js";
import { SessionStateContext } from "@/stores/session-store/context.js";
import { initialState, reducer } from "@/stores/session-store/reducer.js";
import { createSseEventHandler } from "@/stores/session-store/sse-handler.js";
import type { StreamMessage } from "@/stores/session-store/types.js";
import { StoryRevealProvider } from "../story-reveal-context.js";
import { StageDialog } from "@/components/session/stage/StageDialog.js";
vi.mock("@/hooks/use-media-query.js", () => ({ useMediaQuery: () => false }));
vi.mock("@/stores/ui-slot-store.js", () => ({
  useUiSlots: () => [],
  applyUiSlotEvent: () => false,
}));
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({ state: initialState }),
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const hidden = () =>
  document.querySelectorAll('[data-reveal-hidden="true"]').length;
const segments: NonNullable<StreamMessage["segments"]> = [
  { kind: "narration", text: "**Complete first.**" },
  {
    kind: "dialogue",
    text: "Second whole paragraph.",
    speaker: "Resolved",
    speakerId: "public-character",
  },
  { kind: "narration", text: "```text\nline one\n\nline two\n```" },
];
const message: StreamMessage = {
  id: "durable",
  role: "assistant",
  kind: "story",
  content: segments.map((segment) => segment.text).join("\n\n"),
  segments,
  timestamp: "now",
  turnId: "turn",
};
const specs = [
  {
    pluginId: "arbitrary-community-author",
    specs: [
      {
        label: undefined,
        match: { kind: "dialogue" as const },
        reveal: { mode: "segments" as const, intervalMs: 500 },
        view: {
          component: "Prose",
          props: { content: { $state: "/segment/text" } },
        },
      },
    ],
  },
];

it("reveals only a committed delivery, preserving full Markdown, speakers and canonical export content", async () => {
  const original = JSON.stringify(message);
  let state = {
    ...initialState,
    messages: [{ ...message, id: "history" }] as StreamMessage[],
    segmentUiSpecs: specs,
  };
  const stateRef = { current: state };
  const handle = createSseEventHandler({
    stateRef,
    sessionIdRef: { current: "s" },
    lastBackfilledTurnIdRef: { current: null },
    dispatch: (action) => {
      state = reducer(state, action) as typeof state;
      stateRef.current = state;
    },
  });
  const body = () => (
    <SessionStateContext value={state}>
      <StoryRevealProvider sessionId="s" messages={state.messages}>
        {state.messages.map((value) => (
          <StoryMessageBody key={value.id} message={value} sessionId="s" />
        ))}
      </StoryRevealProvider>
    </SessionStateContext>
  );
  const view = render(body());
  await waitFor(() =>
    expect(document.querySelector("pre code")?.textContent).toBe(
      "line one\n\nline two\n",
    ),
  );
  const event = (type: string, payload: Record<string, unknown>) => ({
    type,
    payload,
    sessionId: "s",
    turnId: "turn",
    requestId: "r",
    traceId: "t",
    flowId: "f",
    seq: 1,
    timestamp: "now",
  });
  act(() =>
    handle(
      event("runtime.completed", {
        runtimeId: "p/story",
        pluginId: "p",
        output: "REJECTED CANDIDATE",
      }),
    ),
  );
  view.rerender(body());
  expect(screen.queryByText("REJECTED CANDIDATE")).toBeNull();
  vi.useFakeTimers();
  act(() =>
    handle(
      event("narrative.completed", {
        messageId: message.id,
        kind: "story",
        content: message.content,
        segments,
      }),
    ),
  );
  view.rerender(body());
  expect(hidden()).toBe(2);
  expect(state.messages[1]?.content).toBe(message.content);
  expect(JSON.stringify(state.messages)).not.toContain("reveal");
  expect(document.querySelector("strong")?.textContent).toBe("Complete first.");
  expect(document.querySelector("pre code")?.textContent).toBe(
    "line one\n\nline two\n",
  );
  act(() =>
    handle(
      event("narrative.completed", {
        messageId: message.id,
        kind: "story",
        content: message.content,
        segments,
      }),
    ),
  );
  view.rerender(body());
  expect(state.messages.map((value) => value.id)).toEqual([
    "history",
    "durable",
  ]);
  expect(hidden()).toBe(2);
  act(() => vi.advanceTimersByTime(500));
  expect(hidden()).toBe(1);
  act(() => vi.advanceTimersByTime(500));
  expect(hidden()).toBe(0);
  expect(JSON.stringify(message)).toBe(original);
  view.unmount();
  render(body());
  expect(hidden()).toBe(0);
});

it("uses complete Markdown in the stage, including blank lines inside a code fence", async () => {
  render(<StageDialog message={message} autoPlay={false} />);
  await waitFor(() =>
    expect(document.querySelector("pre code")?.textContent).toBe(
      "line one\n\nline two\n",
    ),
  );
  expect(screen.getByTestId("stage-dialog-speaker").textContent).toBe(
    "Resolved",
  );
  expect(document.querySelectorAll("pre")).toHaveLength(1);
});

it("registers Reveal for arbitrary declarative children and leaves controls immediately usable", () => {
  function Panel() {
    const [revision, change] = useState("initial");
    const spec = pluginPanelViewToSpec({
      component: "Reveal",
      props: { revealKey: revision, mode: "segments", intervalMs: 500 },
      children: [
        { component: "Text", props: { content: "Display one" } },
        { component: "Text", props: { content: "Display two" } },
        { component: "Button", props: { label: "Immediate action" } },
      ],
    });
    return (
      <>
        <button onClick={() => change("new-data")}>New committed data</button>
        <JSONUIProvider registry={covelRegistry} initialState={{}}>
          <Renderer spec={spec!} registry={covelRegistry} />
        </JSONUIProvider>
      </>
    );
  }
  vi.useFakeTimers();
  render(<Panel />);
  expect(hidden()).toBe(0);
  fireEvent.click(screen.getByText("New committed data"));
  expect(hidden()).toBe(1);
  expect(
    screen
      .getByRole("button", { name: "Immediate action" })
      .closest("[data-reveal-unit]")
      ?.getAttribute("data-reveal-hidden"),
  ).toBe("false");
});
