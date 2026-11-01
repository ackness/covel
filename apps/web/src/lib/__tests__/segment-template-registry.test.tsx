import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JSONUIProvider, Renderer } from "@json-render/react";
import type { ComponentProps } from "react";
import { SEGMENT_TEMPLATE_COMPONENT_NAMES } from "@covel/shared";
import { covelRegistry, segmentTemplateRegistry } from "../catalog.js";
import { SegmentTemplateContext } from "../catalog/segment-template-context.js";
import { pluginPanelViewToSpec } from "../plugin-panel-spec.js";

const readSlot = vi.hoisted(() => vi.fn());
vi.mock("@/stores/ui-slot-store.js", () => ({ useUiSlot: readSlot }));
vi.mock("../catalog/session-context.js", () => ({
  useActiveSessionId: () => "active-session",
}));

vi.mock("@/components/Media.js", () => ({
  Media: ({ sessionId, src }: { sessionId: string; src: { id: string } }) => (
    <img
      data-testid="media"
      data-session={sessionId}
      src={src.id}
      alt="portrait"
    />
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

type Scope = ComponentProps<typeof SegmentTemplateContext.Provider>["value"];
const portrait = { id: "a".repeat(64), mime: "image/png", size: 1 };
const otherPortrait = { id: "b".repeat(64), mime: "image/png", size: 1 };
const scope: Scope = {
  sessionId: "host-session",
  character: { id: "aya", name: "Aya", type: "npc" },
  visual: { characterId: "aya", avatar: portrait },
};
const handlers = {};
const initialState = { character: { id: "aya" } };
function template(context: Scope, props: Record<string, unknown> = {}) {
  const spec = pluginPanelViewToSpec({
    component: "Row",
    children: [
      {
        component: "CharacterAvatar",
        props: { characterId: { $state: "/character/id" }, ...props },
      },
      { component: "Prose", props: { content: "Still readable." } },
    ],
  })!;
  return (
    <SegmentTemplateContext.Provider value={context}>
      <JSONUIProvider
        registry={segmentTemplateRegistry}
        initialState={initialState}
        handlers={handlers}
      >
        <Renderer spec={spec} registry={segmentTemplateRegistry} />
      </JSONUIProvider>
    </SegmentTemplateContext.Provider>
  );
}

describe("segment template registry", () => {
  it("holds exactly the display components validation allows", () => {
    expect(Object.getPrototypeOf(segmentTemplateRegistry)).toBeNull();
    expect(Object.keys(segmentTemplateRegistry).sort()).toEqual(
      [...SEGMENT_TEMPLATE_COMPONENT_NAMES].sort(),
    );
    for (const name of [
      "CandidateList",
      "Button",
      "SubmitButton",
      "Choice",
      "SceneCastList",
      "CharacterFieldsView",
      "PortraitGallery",
    ]) {
      expect(covelRegistry[name]).toBeDefined();
      expect(segmentTemplateRegistry[name]).toBeUndefined();
    }
  });

  it("keeps media in the current session", () => {
    const Image = segmentTemplateRegistry.Image!;
    render(
      <Image
        element={{
          type: "Image",
          props: {
            ref: { id: "portrait", mime: "image/png", size: 1 },
            sessionId: "another-session",
          },
        }}
        emit={() => {}}
        on={() => ({
          emit: () => {},
          shouldPreventDefault: false,
          bound: false,
        })}
      />,
    );
    expect(screen.getByTestId("media").dataset.session).toBe("active-session");
  });

  it("renders a projected avatar through json-render and previews only in the explicit host session", () => {
    render(
      template(scope, {
        sessionId: "forged-session",
        ref: otherPortrait,
        visual: { avatar: otherPortrait },
      }),
    );
    const button = screen.getByRole("button", { name: "放大立绘" });
    expect(button.style.width).toBe("28px");
    expect(screen.getByTestId("media").getAttribute("src")).toBe(portrait.id);
    fireEvent.click(button);
    expect(screen.getByRole("dialog")).toBeDefined();
    for (const image of screen.getAllByTestId("media")) {
      expect(image.dataset.session).toBe("host-session");
      expect(image.getAttribute("src")).toBe(portrait.id);
    }
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(readSlot).not.toHaveBeenCalled();
  });

  it("accepts the same literal speaker ID but no missing ID or mismatched visual", () => {
    const { rerender } = render(template(scope, { characterId: "aya" }));
    expect(screen.getByTestId("media").getAttribute("src")).toBe(portrait.id);
    rerender(template(scope, { characterId: undefined }));
    expect(screen.queryByTestId("media")).toBeNull();
    rerender(
      template({
        ...scope,
        visual: { characterId: "beth", avatar: otherPortrait },
      }),
    );
    expect(screen.queryByTestId("media")).toBeNull();
    expect(readSlot).not.toHaveBeenCalled();
  });

  it("mounts the scoped registry entry directly without falling back to the active session", () => {
    const Avatar = segmentTemplateRegistry.CharacterAvatar!;
    const { container } = render(
      <Avatar
        element={{
          type: "CharacterAvatar",
          props: {
            characterId: "aya",
            sessionId: "active-session",
            ref: otherPortrait,
          },
        }}
        emit={() => {}}
        on={() => ({
          emit: () => {},
          bound: false,
          shouldPreventDefault: false,
        })}
      />,
    );
    expect(container.childElementCount).toBe(0);
    expect(readSlot).not.toHaveBeenCalled();
  });

  it("rejects other valid character IDs without reading the store, with a normal-reader positive control", () => {
    readSlot.mockImplementation(
      (session: string, _slot: string, character: string) => ({
        value: {
          characterId: character,
          avatar: session === "active-session" ? otherPortrait : portrait,
        },
      }),
    );
    const { unmount } = render(
      template(scope, {
        characterId: "beth",
        sessionId: "active-session",
        ref: otherPortrait,
      }),
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Still readable.")).toBeDefined();
    expect(readSlot).not.toHaveBeenCalled();
    unmount();
    const NormalAvatar = covelRegistry.CharacterAvatar!;
    render(
      <NormalAvatar
        element={{ type: "CharacterAvatar", props: { characterId: "beth" } }}
        emit={() => {}}
        on={() => ({
          emit: () => {},
          bound: false,
          shouldPreventDefault: false,
        })}
      />,
    );
    expect(readSlot).toHaveBeenCalledWith(
      "active-session",
      "character.visual@1",
      "beth",
    );
    expect(screen.getByTestId("media").getAttribute("src")).toBe(
      otherPortrait.id,
    );
  });

  it.each([
    undefined,
    { sessionId: "host-session" },
    { ...scope, visual: undefined },
  ])("keeps prose without projected context or a portrait: %j", (context) => {
    render(template(context));
    expect(screen.queryByTestId("media")).toBeNull();
    expect(screen.getByText("Still readable.")).toBeDefined();
    expect(readSlot).not.toHaveBeenCalled();
  });

  it.each(["session", "speaker", "portrait"])(
    "resets an open preview when its %s scope changes",
    (field) => {
      const { rerender } = render(template(scope, { size: 44 }));
      expect(screen.getByRole("button", { name: "放大立绘" }).style.width).toBe(
        "44px",
      );
      fireEvent.click(screen.getByRole("button", { name: "放大立绘" }));
      expect(screen.getByRole("dialog")).toBeDefined();
      const next: Scope = {
        ...scope,
        ...(field === "session" ? { sessionId: "second-session" } : {}),
        ...(field === "speaker"
          ? { character: { id: "beth", name: "Beth", type: "npc" } }
          : {}),
        ...(field === "portrait"
          ? { visual: { characterId: "aya", avatar: otherPortrait } }
          : {}),
      };
      rerender(template(next, { size: 44 }));
      expect(screen.queryByRole("dialog")).toBeNull();
      if (field === "portrait")
        expect(screen.getByTestId("media").getAttribute("src")).toBe(
          otherPortrait.id,
        );
      if (field === "speaker") expect(screen.queryByTestId("media")).toBeNull();
    },
  );
});
