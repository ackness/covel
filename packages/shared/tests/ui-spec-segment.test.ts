import { describe, expect, it } from "vitest";
import { pluginUiSpecIssues } from "../src/schemas/ui-spec.js";
import { pluginUiPathsSchema } from "../src/schemas/plugin-schemas.js";

const view = {
  component: "Prose",
  props: { content: { $state: "/segment/text" } },
};

const segmentIssues = (spec: unknown) =>
  pluginUiSpecIssues(spec, "owner", "segment");
const paths = (spec: unknown) => segmentIssues(spec).map((issue) => issue.path);

describe("segment template rules", () => {
  it("accepts a match by kind, by speaker, or both", () => {
    expect(segmentIssues({ match: { kind: "dialogue" }, view })).toEqual([]);
    expect(segmentIssues({ match: { speaker: ["阿雅"] }, view })).toEqual([]);
    expect(
      segmentIssues({
        id: "nameplate",
        label: "Nameplate",
        match: { kind: ["dialogue", "action"], speaker: "char-aya" },
        view,
      }),
    ).toEqual([]);
  });

  it("requires a non-empty match", () => {
    expect(paths({ view })).toEqual(["match"]);
    expect(segmentIssues({ match: {}, view })).toEqual([
      { path: "match", message: "match needs kind, speaker or both" },
    ]);
    expect(paths({ match: { kind: [] }, view })).toContain("match.kind");
    expect(paths({ match: { kind: "aside" }, view })).toContain("match.kind");
    expect(paths({ match: { speakers: "Ana" }, view })).toContain("match");
  });

  it("limits speakers to 80 characters and lists to 16 entries", () => {
    expect(paths({ match: { speaker: "x".repeat(81) }, view })).toEqual([
      "match.speaker",
    ]);
    expect(paths({ match: { speaker: "x".repeat(80) }, view })).toEqual([]);
    expect(paths({ match: { speaker: " " }, view })).toEqual(["match.speaker"]);
    expect(
      paths({
        match: { kind: Array.from({ length: 17 }, () => "dialogue") },
        view,
      }),
    ).toEqual(["match.kind"]);
  });

  it("rejects a webview, data, panel fields, bridge and actions", () => {
    const match = { kind: "dialogue" };
    expect(paths({ match, webview: { entry: "nameplate.html" } })).toContain(
      "webview",
    );
    expect(paths({ match, view, dataSource: { namespace: "x" } })).toEqual([
      "dataSource",
    ]);
    expect(paths({ match, view, bridge: "session" })).toContain("bridge");
    expect(
      paths({ match, view, surfaces: ["stage"], alwaysRender: true }),
    ).toEqual(["surfaces", "alwaysRender"]);
    expect(
      paths({
        match,
        view: {
          component: "Stack",
          children: [
            {
              component: "Button",
              props: { label: "Again" },
              on: { press: { action: "sendMessage" } },
            },
          ],
          watch: { "/segment": { action: "refresh" } },
        },
      }),
    ).toEqual([
      "view.watch",
      "view.children[0].component",
      "view.children[0].on",
    ]);
  });

  it("allows only display components, without action props", () => {
    const match = { kind: "dialogue" };
    // A literal candidate list would draw Send buttons and call runtimes
    // through its accept and regenerate actions, with no `on` binding.
    expect(
      paths({
        match,
        view: {
          component: "Stack",
          children: [
            {
              component: "CandidateList",
              props: {
                candidates: [{ text: "Again" }],
                acceptAction: { pluginId: "owner", runtimeId: "accept" },
              },
            },
            {
              type: "SubmitButton",
              props: { label: "Send" },
            },
            {
              component: "CharacterFieldsView",
              props: { characterId: { $state: "/segment/speakerId" } },
            },
          ],
        },
      }),
    ).toEqual([
      "view.children[0].component",
      "view.children[1].type",
      "view.children[2].component",
    ]);
    for (const component of [
      "Button",
      "Choice",
      "Input",
      "Tabs",
      "FilterContainer",
      "SceneCastList",
      "CharacterAvatar",
      "PortraitGallery",
      "MediaGallery",
      "WorldDimensions",
      "AssetTurnSidebar",
    ])
      expect(paths({ match, view: { component } })).toContain("view.component");
    expect(
      segmentIssues({
        match,
        view: {
          component: "Row",
          children: [
            {
              component: "Image",
              props: { ref: { $state: "/visual/avatar" } },
            },
            {
              component: "Badge",
              props: { label: { $state: "/character/name" } },
            },
            { component: "Prose", props: { content: "x" } },
          ],
        },
      }),
    ).toEqual([]);
    // Other placements keep the whole catalogue.
    expect(
      pluginUiSpecIssues({ view: { component: "CandidateList" } }, "owner"),
    ).toEqual([]);
  });

  it("leaves other placements unchanged", () => {
    expect(pluginUiSpecIssues({ view }, "owner", "message")).toEqual([]);
    expect(
      pluginUiSpecIssues(
        { view: { ...view, on: { press: { action: "x" } } } },
        "owner",
        "right",
      ),
    ).toEqual([]);
  });

  it("is declared under contributes.ui.segment", () => {
    expect(
      pluginUiPathsSchema.parse({ segment: ["ui/nameplate.json"] }),
    ).toEqual({ segment: ["ui/nameplate.json"] });
    expect(pluginUiPathsSchema.safeParse({ segment: [""] }).success).toBe(
      false,
    );
  });
});
