import { describe, expect, it } from "vitest";
import type { SseEnvelope } from "@/services/api";
import {
  createStoryRevealVisit,
  registerStoryRevealVisit,
  storyRevision,
} from "@/lib/reveal/committed-stories.js";
import { initialState, reducer } from "../reducer.js";
import { createSseEventHandler } from "../sse-handler.js";
import {
  draftStoryMessage,
  visibleDraftUnits,
  type OutputDraft,
} from "../output-drafts.js";
import type { SessionState } from "../types.js";

const identity = {
  turnId: "turn-1",
  runtimeId: "narrator",
  pluginId: "narrator",
};
const narration = { text: "雨停了。", meta: { kind: "narration" } };
const line = {
  text: "「走吧。」",
  meta: { kind: "dialogue", speaker: "阿雅" },
};

function liveSession() {
  const stateRef: { current: SessionState } = {
    current: { ...initialState, executing: true },
  };
  const handle = createSseEventHandler({
    dispatch: (action) => {
      stateRef.current = reducer(stateRef.current, action);
    },
    sessionIdRef: { current: "sess-1" },
    stateRef,
    lastBackfilledTurnIdRef: { current: null },
  });
  let seq = 0;
  const send = (type: string, payload: Record<string, unknown>) =>
    handle({
      type,
      requestId: "req-1",
      traceId: "trace-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      flowId: "trace-1",
      seq: seq++,
      timestamp: "2026-11-03T00:00:00.000Z",
      payload,
    } satisfies SseEnvelope);
  const drafts = () => stateRef.current.outputDrafts;
  return { stateRef, send, drafts };
}

describe("story drafts in the session store", () => {
  it("shows a story held for review when it arrives already accepted", () => {
    const { send, drafts } = liveSession();
    send("output.accepted", {
      ...identity,
      draftId: "run:1:accepted",
      units: [narration, line],
    });
    expect(drafts()).toHaveLength(1);
    const [held] = drafts();
    expect(held).toMatchObject({ accepted: true, revising: false });
    expect(visibleDraftUnits(held!, "units")).toEqual([narration, line]);
    expect(visibleDraftUnits(held!, "committed")).toBeUndefined();
  });

  it("follows a draft through a revision to the committed story", () => {
    const { stateRef, send, drafts } = liveSession();
    const visit = createStoryRevealVisit([]);
    const unregister = registerStoryRevealVisit("sess-1", visit);
    try {
      send("output.draft", {
        ...identity,
        draftId: "a",
        mode: "units",
        units: [narration],
      });
      expect(drafts()).toMatchObject([{ draftId: "a", units: [narration] }]);
      send("output.retracted", {
        ...identity,
        draftId: "a",
        reason: "revising",
      });
      expect(drafts()).toMatchObject([
        { draftId: "a", units: [], revising: true },
      ]);
      // A late retraction of another draft changes nothing.
      send("output.retracted", {
        ...identity,
        draftId: "x",
        reason: "stopped",
      });
      expect(drafts()).toHaveLength(1);
      send("output.draft", {
        ...identity,
        draftId: "b",
        mode: "text",
        units: [narration],
        partial: { text: "「走", meta: { kind: "dialogue" } },
      });
      send("output.accepted", {
        ...identity,
        draftId: "b",
        units: [narration, line],
      });
      expect(drafts()).toEqual([
        {
          ...identity,
          draftId: "b",
          units: [narration, line],
          accepted: true,
          revising: false,
        },
      ]);
      const story = {
        id: "story-1",
        content: "雨停了。\n\n「走吧。」",
        segments: [
          { kind: "narration", text: "雨停了。" },
          { kind: "dialogue", speaker: "阿雅", text: "「走吧。」" },
        ],
      };
      send("narrative.completed", {
        content: story.content,
        segments: story.segments,
        runtimeId: "narrator",
        messageId: story.id,
        kind: "story",
      });
      expect(drafts()).toEqual([]);
      expect(stateRef.current.messages.map((message) => message.id)).toEqual([
        "story-1",
      ]);
      // Delivered for reveal, marked as already read on surfaces with drafts.
      const revision = storyRevision(story);
      expect(visit.eligible(revision)).toBe(true);
      expect(visit.shownAsDraft(revision)).toBe(true);
    } finally {
      unregister();
    }
  });

  it("drops drafts that a failed runtime or an uncommitted turn leaves behind", () => {
    const { send, drafts } = liveSession();
    const draft = (runtimeId: string) =>
      send("output.draft", {
        ...identity,
        runtimeId,
        draftId: runtimeId,
        mode: "units",
        units: [narration],
      });
    draft("narrator");
    draft("chorus");
    send("runtime.failed", { runtimeId: "chorus", pluginId: "chorus" });
    expect(drafts().map((entry) => entry.runtimeId)).toEqual(["narrator"]);
    send("execution.completed", { committed: false });
    expect(drafts()).toEqual([]);
  });

  it("removes a stopped draft and ignores malformed events", () => {
    const { send, drafts } = liveSession();
    send("output.draft", { ...identity, draftId: "a", mode: "units" });
    expect(drafts()).toEqual([]);
    send("output.draft", {
      ...identity,
      draftId: "a",
      mode: "units",
      units: [narration],
    });
    send("output.retracted", { ...identity, draftId: "a", reason: "stopped" });
    expect(drafts()).toEqual([]);
  });
});

describe("what a player sees of a draft", () => {
  const draft: OutputDraft = {
    ...identity,
    draftId: "a",
    units: [narration],
    partial: { text: "「走", meta: { kind: "dialogue", speaker: "阿雅" } },
    accepted: false,
    revising: false,
  };

  it("never shows more than the player allows", () => {
    expect(visibleDraftUnits(draft, "text")?.map((unit) => unit.text)).toEqual([
      "雨停了。",
      "「走",
    ]);
    expect(visibleDraftUnits(draft, "units")?.map((unit) => unit.text)).toEqual(
      ["雨停了。"],
    );
    expect(visibleDraftUnits(draft, "committed")).toBeUndefined();
    expect(visibleDraftUnits({ ...draft, units: [] }, "units")).toBeUndefined();
  });

  it("reads like the story it becomes", () => {
    expect(
      draftStoryMessage(draft, visibleDraftUnits(draft, "text")!),
    ).toMatchObject({
      id: "draft:turn-1:narrator",
      role: "assistant",
      kind: "story",
      content: "雨停了。\n\n「走",
      segments: [
        { kind: "narration", text: "雨停了。" },
        { kind: "dialogue", speaker: "阿雅", text: "「走" },
      ],
    });
    const plain = draftStoryMessage(draft, [{ text: "Plain story." }]);
    expect(plain.content).toBe("Plain story.");
    expect(plain.segments).toBeUndefined();
  });
});
