import { segmentTemplateMatchSchema, revealPolicySchema } from "@covel/shared";
import type { ComponentProps } from "react";
import type { TFunction } from "i18next";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import dialogueLine from "../../../../../../../plugins/scene-stage/ui/dialogue-line.json";
import type { UISlotEntry } from "@/services/api/plugin-data.js";
import { SessionStateContext } from "@/stores/session-store/context.js";
import { initialState } from "@/stores/session-store/reducer.js";
import type { StreamMessage } from "@/stores/session-store.js";
import { ChatMessageRenderer } from "../chat-message-renderer.js";

const visuals = vi.hoisted(() => ({
  items: [] as Array<{ key: string; value: unknown }>,
  mediaProps: [] as unknown[],
}));
vi.mock("@/stores/ui-slot-store.js", () => ({
  useUiSlots: () => visuals.items,
}));
vi.mock("@/components/Media.js", () => ({
  Media: (props: { src: { id: string }; sessionId: string }) => {
    visuals.mediaProps.push(props);
    return (
      <img
        alt="projected portrait"
        src={props.src.id}
        data-session={props.sessionId}
      />
    );
  },
}));
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

afterEach(() => {
  cleanup();
  visuals.items = [];
  visuals.mediaProps = [];
});

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
      characters: [
        {
          id: "char-aya",
          name: "阿雅",
          type: "companion",
          fields: { secret: "PRIVATE-BRIEF" },
          description: "HIDDEN-DESCRIPTION",
        },
        { id: "char-beth", name: "贝丝", type: "npc" },
      ],
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
    const parts = [
      ...body.querySelectorAll("[data-reveal-unit] > div"),
    ] as HTMLElement[];
    expect(parts).toHaveLength(3);
    // Unmatched narration: default prose of its text.
    expect(parts[0]!.dataset.segmentTemplate).toBeUndefined();
    expect(parts[0]!.textContent).toBe("雨停了。");
    // Matched dialogue: the template reads the segment and its character.
    expect(parts[1]!.dataset.segmentTemplate).toBe("plates");
    expect(within(parts[1]!).getByText("阿雅")).toBeDefined();
    expect(within(parts[1]!).getByText("companion")).toBeDefined();
    expect(within(parts[1]!).getByText("「走吧。」")).toBeDefined();
    // The throwing template falls back to the default for its own segment.
    expect(parts[2]!.dataset.segmentTemplate).toBe("broken");
    expect(parts[2]!.textContent).toBe("陌生人「等等！」");
  });

  it.each(["parsed", "detailed"] as const)(
    "renders the bundled avatar template and keeps unresolved prose readable in %s",
    (viewMode) => {
      const avatar = { id: "a".repeat(64), mime: "image/png", size: 1 };
      visuals.items = [
        { key: "char-aya", value: { characterId: "char-aya", avatar } },
        {
          key: "char-beth",
          value: {
            characterId: "char-beth",
            avatar: { ...avatar, id: "b".repeat(64) },
          },
        },
      ];
      renderMessage(story, {
        viewMode,
        specs: [
          {
            pluginId: "scene-stage",
            specs: [
              {
                ...dialogueLine,
                reveal: revealPolicySchema.parse(dialogueLine.reveal),
                label: undefined,
                match: segmentTemplateMatchSchema.parse(dialogueLine.match),
              },
            ],
          },
        ],
      });
      const body = screen.getByTestId("story-segments");
      expect(within(body).getByText("阿雅")).toBeDefined();
      expect(within(body).getByText("「走吧。」")).toBeDefined();
      expect(within(body).getByText("陌生人")).toBeDefined();
      expect(within(body).getByText("「等等！」")).toBeDefined();
      const avatarButton = within(body).getByRole("button", {
        name: "放大立绘",
      });
      expect(within(body).getAllByRole("button")).toHaveLength(1);
      expect(
        screen.getByAltText("projected portrait").getAttribute("src"),
      ).toBe(avatar.id);
      fireEvent.click(avatarButton);
      expect(screen.getByRole("dialog")).toBeDefined();
      for (const image of screen.getAllByAltText("projected portrait")) {
        expect(image.dataset.session).toBe("s");
        expect(image.getAttribute("src")).toBe(avatar.id);
      }
      fireEvent.click(screen.getByRole("button", { name: "关闭" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.body.textContent).not.toMatch(
        /PRIVATE-BRIEF|HIDDEN-DESCRIPTION/,
      );
      expect(JSON.stringify(visuals.mediaProps)).not.toMatch(
        /PRIVATE-BRIEF|HIDDEN-DESCRIPTION|char-beth/,
      );
      expect(visuals.mediaProps).toContainEqual(
        expect.objectContaining({ src: avatar, sessionId: "s" }),
      );
      expect(within(body).queryByRole("button", { name: "Send" })).toBeNull();
    },
  );

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

  it("renders a story with no template and no named speaker as plain narrative", () => {
    const narration = {
      ...story,
      segments: [
        { kind: "narration" as const, text: "雨停了。" },
        // A narration segment's speaker is not shown.
        { kind: "narration" as const, speaker: "阿雅", text: "风很冷。" },
      ],
      content: "雨停了。\n\n风很冷。",
    };
    const unmatched = renderMessage(narration, {
      specs: [
        {
          pluginId: "plates",
          specs: [{ ...nameplate, match: { kind: "action" as const } }],
        },
      ],
    }).container.innerHTML;
    cleanup();
    const { segments: _segments, ...plain } = narration;
    const before = renderMessage(plain).container.innerHTML;
    expect(unmatched).toBe(before);
    expect(screen.queryByTestId("story-segments")).toBeNull();
  });

  const nothingMatches: UISlotEntry[] = [
    {
      pluginId: "plates",
      specs: [{ ...nameplate, match: { kind: "action" as const } }],
    },
  ];
  it.each<[string, UISlotEntry[]]>([
    ["no templates", []],
    ["templates that match nothing", nothingMatches],
  ])("names dialogue speakers with %s", (_label, specs) => {
    renderMessage(story, { specs });
    const body = screen.getByTestId("story-segments");
    const parts = [
      ...body.querySelectorAll("[data-reveal-unit] > div"),
    ] as HTMLElement[];
    expect(parts.map((part) => part.textContent)).toEqual([
      "雨停了。",
      "阿雅「走吧。」",
      "陌生人「等等！」",
    ]);
    expect(
      within(body)
        .getAllByTestId("segment-speaker")
        .map((plate) => plate.textContent),
    ).toEqual(["阿雅", "陌生人"]);
  });

  it("draws full committed story through templates regardless of its durable ID", () => {
    renderMessage(
      { ...story, id: "another-durable-id" },
      { specs: [{ pluginId: "plates", specs: [nameplate] }] },
    );
    expect(screen.getByTestId("story-segments")).toBeDefined();
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
