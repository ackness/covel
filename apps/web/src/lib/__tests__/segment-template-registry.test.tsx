import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SEGMENT_TEMPLATE_COMPONENT_NAMES } from "@covel/shared";
import { covelRegistry, segmentTemplateRegistry } from "../catalog.js";

vi.mock("@/components/Media.js", () => ({
  Media: ({ sessionId }: { sessionId: string }) => (
    <span data-testid="media" data-session={sessionId} />
  ),
}));

afterEach(cleanup);

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
      "CharacterAvatar",
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
    expect(screen.getByTestId("media").dataset.session).toBe("");
  });
});
