// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { StoryMessageSegment } from "@covel/shared";
import type { UISlotEntry } from "@/services/api/plugin-data.js";
import {
  compileSegmentTemplates,
  planSegmentTemplates,
  segmentTemplateState,
  selectSegmentTemplate,
} from "../segment-templates.js";

const view = { component: "Text", props: { content: "x" } };

function entry(
  pluginId: string,
  ...matches: Record<string, unknown>[]
): UISlotEntry {
  return {
    pluginId,
    specs: matches.map((match, index) => ({
      id: `${pluginId}-${index}`,
      label: undefined,
      match,
      view,
    })),
  };
}

const aya: StoryMessageSegment = {
  kind: "dialogue",
  speaker: "阿雅",
  speakerId: "char-aya",
  text: "「走吧。」",
};
const narration: StoryMessageSegment = { kind: "narration", text: "雨停了。" };

const chosen = (entries: UISlotEntry[], segment: StoryMessageSegment) =>
  selectSegmentTemplate(compileSegmentTemplates(entries), segment)?.spec.id;

describe("segment template selection", () => {
  it("prefers kind + speaker, then speaker, then kind", () => {
    const byKind = entry("kind", { kind: "dialogue" });
    const bySpeaker = entry("speaker", { speaker: "阿雅" });
    const byBoth = entry("both", { kind: "dialogue", speaker: "阿雅" });
    expect(chosen([byKind, bySpeaker, byBoth], aya)).toBe("both-0");
    expect(chosen([byKind, bySpeaker], aya)).toBe("speaker-0");
    expect(chosen([byKind], aya)).toBe("kind-0");
    // Every given key must match.
    expect(
      chosen([entry("both", { kind: "action", speaker: "阿雅" })], aya),
    ).toBeUndefined();
  });

  it("breaks ties by plugin order, then declaration order", () => {
    const first = entry("first", { kind: "dialogue" }, { kind: "dialogue" });
    const second = entry("second", { kind: "dialogue" });
    expect(chosen([first, second], aya)).toBe("first-0");
    expect(chosen([second, first], aya)).toBe("second-0");
    expect(
      chosen([entry("one", { kind: "action" }, { kind: ["dialogue"] })], aya),
    ).toBe("one-1");
  });

  it("matches a speaker by character ID before the name as written", () => {
    expect(chosen([entry("id", { speaker: "char-aya" })], aya)).toBe("id-0");
    expect(
      chosen(
        [
          entry("name", { speaker: "阿雅" }),
          entry("id", { speaker: ["someone", "char-aya"] }),
        ],
        aya,
      ),
    ).toBe("id-0");
    // A name is compared exactly after trimming.
    expect(
      chosen([entry("name", { speaker: " 阿雅 " })], {
        ...aya,
        speakerId: undefined,
        speaker: "阿雅 ",
      }),
    ).toBe("name-0");
    expect(chosen([entry("name", { speaker: "小雅" })], aya)).toBeUndefined();
  });

  it("never matches narration with a speaker rule", () => {
    const templates = [
      entry("speaker", { speaker: "阿雅" }),
      entry("both", { kind: ["narration", "dialogue"], speaker: "阿雅" }),
    ];
    expect(
      chosen(templates, { ...narration, speaker: "阿雅" }),
    ).toBeUndefined();
    expect(
      chosen([...templates, entry("kind", { kind: "narration" })], narration),
    ).toBe("kind-0");
  });

  it("skips specs without a valid match or a view", () => {
    const templates = compileSegmentTemplates([
      {
        pluginId: "broken",
        specs: [
          { label: undefined, view },
          { label: undefined, match: {}, view },
          { label: undefined, match: { kind: "dialogue" } },
        ],
      },
    ]);
    expect(templates).toEqual([]);
  });

  it("plans templates only when some segment matches", () => {
    const templates = compileSegmentTemplates([
      entry("kind", { kind: "dialogue" }),
    ]);
    expect(
      planSegmentTemplates(templates, [narration, aya])?.map(
        (template) => template?.spec.id,
      ),
    ).toEqual([undefined, "kind-0"]);
    expect(planSegmentTemplates(templates, [narration])).toBeUndefined();
    expect(planSegmentTemplates([], [aya])).toBeUndefined();
  });
});

describe("segment template state", () => {
  const characters = [
    {
      id: "char-aya",
      name: "阿雅",
      type: "npc",
      description: "never exposed",
      fields: { secret: 1 },
    },
  ];
  const visual = { portrait: "aya.png" } as never;

  it("exposes the segment, its index, and the resolved speaker's public fields", () => {
    expect(
      segmentTemplateState(aya, 2, characters, new Map([["char-aya", visual]])),
    ).toEqual({
      segment: aya,
      index: 2,
      character: { id: "char-aya", name: "阿雅", type: "npc" },
      visual,
    });
  });

  it("leaves the character out when the speaker is unresolved", () => {
    expect(
      segmentTemplateState(
        { kind: "dialogue", speaker: "陌生人", text: "「等等！」" },
        0,
        characters,
        new Map(),
      ),
    ).toEqual({
      segment: { kind: "dialogue", speaker: "陌生人", text: "「等等！」" },
      index: 0,
    });
  });
});
