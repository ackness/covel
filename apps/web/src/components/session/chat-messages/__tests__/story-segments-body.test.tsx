import type { ComponentProps } from "react";
import type { TFunction } from "i18next";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UISlotEntry } from "@/services/api/plugin-data.js";
import { SessionStateContext } from "@/stores/session-store/context.js";
import { initialState } from "@/stores/session-store/reducer.js";
import type { StreamMessage } from "@/stores/session-store.js";
import { ChatMessageRenderer } from "../chat-message-renderer.js";

vi.mock("@/stores/ui-slot-store.js", () => ({ useUiSlots: () => [] }));
// A template whose view names "__throw__" fails to render.
vi.mock("@json-render/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@json-render/react")>();
  return {
    ...actual,
    Renderer: (props: ComponentProps<typeof actual.Renderer>) => {
      if (JSON.stringify(props.spec).includes("__throw__"))
        throw new Error("template failed");
      return <actual.Renderer {...props} />;
    },
  };
});

afterEach(cleanup);

const t = ((key: string, fallback?: string) => fallback ?? key) as TFunction;

const segments = [
  { kind: "narration" as const, text: "雨停了。" },
  {
    kind: "dialogue" as const,
    speaker: "阿雅",
    speakerId: "char-aya",
    text: "「走吧。」",
  },
  { kind: "dialogue" as const, speaker: "陌生人", text: "「等等！」" },
];
const story: StreamMessage = {
  id: "story-1",
  role: "assistant",
  kind: "story",
  content: segments.map((segment) => segment.text).join("\n\n"),
  timestamp: "2026-10-30T00:00:00.000Z",
  turnId: "turn-1",
  segments,
};

const nameplate = {
  id: "nameplate",
  label: undefined,
  match: { kind: "dialogue" as const },
  view: {
    component: "Stack",
    children: [
      {
        component: "Text",
        props: { content: { $state: "/segment/speaker" }, weight: "bold" },
      },
      { component: "Text", props: { content: { $state: "/character/type" } } },
      { component: "Text", props: { content: { $state: "/segment/text" } } },
    ],
  },
};
const failing = {
  id: "failing",
  label: undefined,
  match: { speaker: "陌生人" },
  view: { component: "Text", props: { content: "__throw__" } },
};

function renderMessage(
  msg: StreamMessage,
  {
    specs = [],
    viewMode = "parsed",
  }: {
    specs?: UISlotEntry[];
    viewMode?: "parsed" | "detailed" | "raw";
  } = {},
) {
  const state = {
    ...initialState,
    segmentUiSpecs: specs,
    gameState: {
      characters: [{ id: "char-aya", name: "阿雅", type: "companion" }],
    },
  };
  return render(
    <SessionStateContext.Provider value={state}>
      <ChatMessageRenderer
        msg={msg}
        viewMode={viewMode}
        isImageGenActive={false}
        sessionId="s"
        executing={false}
        generatingImage={false}
        onGenerateImage={() => {}}
        t={t}
      />
    </SessionStateContext.Provider>,
  );
}

describe("story segment templates in the chat view", () => {
  it("draws matched segments through their template and the rest as prose", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    renderMessage(story, {
      specs: [
        { pluginId: "plates", specs: [nameplate] },
        { pluginId: "broken", specs: [failing] },
      ],
    });
    const body = screen.getByTestId("story-segments");
    const parts = [...body.children] as HTMLElement[];
    expect(parts).toHaveLength(3);
    // Unmatched narration: default prose of its text.
    expect(parts[0]!.dataset.segmentTemplate).toBeUndefined();
    expect(parts[0]!.textContent).toBe("雨停了。");
    // Matched dialogue: the template reads the segment and its character.
    expect(parts[1]!.dataset.segmentTemplate).toBe("plates");
    expect(within(parts[1]!).getByText("阿雅")).toBeDefined();
    expect(within(parts[1]!).getByText("companion")).toBeDefined();
    expect(within(parts[1]!).getByText("「走吧。」")).toBeDefined();
    // The throwing template falls back for its own segment only.
    expect(parts[2]!.dataset.segmentTemplate).toBe("broken");
    expect(parts[2]!.textContent).toBe("「等等！」");
  });

  it("leaves components that act or read session data inert", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const acting = {
      id: "acting",
      label: undefined,
      match: { kind: "dialogue" as const },
      view: {
        component: "Stack",
        children: [
          { component: "Text", props: { content: "plate" } },
          // Literal candidates would draw Send and Draft buttons, and the
          // accept action would call a runtime, with no `on` binding.
          {
            component: "CandidateList",
            props: {
              candidates: [{ text: "Again" }],
              acceptAction: { pluginId: "plates", runtimeId: "accept" },
            },
          },
          { component: "SubmitButton", props: { label: "Send" } },
          { component: "Button", props: { label: "Go" } },
          { component: "SceneCastList" },
        ],
      },
    };
    renderMessage(story, { specs: [{ pluginId: "plates", specs: [acting] }] });
    const body = screen.getByTestId("story-segments");
    expect(within(body).getAllByText("plate")).toHaveLength(2);
    expect(within(body).queryAllByRole("button")).toEqual([]);
    expect(body.textContent).not.toContain("Again");
  });

  it("renders a story with no matching template exactly as before", () => {
    const unmatched = renderMessage(story, {
      specs: [
        {
          pluginId: "plates",
          specs: [{ ...nameplate, match: { kind: "action" as const } }],
        },
      ],
    }).container.innerHTML;
    cleanup();
    const { segments: _segments, ...plain } = story;
    const before = renderMessage(plain).container.innerHTML;
    expect(unmatched).toBe(before);
    expect(screen.queryByTestId("story-segments")).toBeNull();
  });

  it("never draws a streaming story through templates", () => {
    renderMessage(
      { ...story, id: "stream_turn-1_narrator" },
      { specs: [{ pluginId: "plates", specs: [nameplate] }] },
    );
    expect(screen.queryByTestId("story-segments")).toBeNull();
  });

  it("shows the segments in the raw view", () => {
    renderMessage(story, {
      viewMode: "raw",
      specs: [{ pluginId: "plates", specs: [nameplate] }],
    });
    expect(screen.queryByTestId("story-segments")).toBeNull();
    expect(document.body.textContent).toContain('"segments"');
    expect(document.body.textContent).toContain('"speakerId": "char-aya"');
  });
});
