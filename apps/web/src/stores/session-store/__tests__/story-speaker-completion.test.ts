import { describe, expect, it } from "vitest";
import type { SseEnvelope } from "@/services/api";
import {
  lastStorySpeaker,
  storyParagraphSpeakers,
} from "@/components/session/stage/stage-dialogue-selectors.js";
import { initialState, reducer } from "../reducer.js";
import {
  createSseEventHandler,
  type SseEventHandlerDeps,
} from "../sse-handler.js";
import type { SessionState, StreamMessage } from "../types.js";

const segments = [
  { kind: "narration" as const, text: "雨停了。" },
  {
    kind: "dialogue" as const,
    speaker: "阿雅",
    speakerId: "char-aya",
    text: "「走吧。」",
  },
];

function liveSession() {
  const stateRef: { current: SessionState } = {
    current: {
      ...initialState,
      executing: true,
      messages: [
        {
          id: "stream_turn-1_narrator",
          role: "assistant",
          content: "雨停了。\n\n「走",
          kind: "story",
          timestamp: "2026-10-30T00:00:00.000Z",
          turnId: "turn-1",
          runtimeId: "narrator",
        },
      ],
    },
  };
  const deps: SseEventHandlerDeps = {
    dispatch: (action) => {
      stateRef.current = reducer(stateRef.current, action);
    },
    ds: {} as SseEventHandlerDeps["ds"],
    sessionIdRef: { current: "sess-1" },
    stateRef,
    deltaBufferRef: { current: new Map() },
    deltaRafRef: { current: null },
    lastBackfilledTurnIdRef: { current: null },
  };
  const completed = (payload: Record<string, unknown>): SseEnvelope => ({
    type: "narrative.completed",
    requestId: "req-1",
    traceId: "trace-1",
    sessionId: "sess-1",
    turnId: "turn-1",
    flowId: "trace-1",
    seq: 4,
    timestamp: "2026-10-30T00:00:01.000Z",
    payload: {
      content: "雨停了。\n\n「走吧。」",
      runtimeId: "narrator",
      messageId: "story-1",
      kind: "story",
      ...payload,
    },
  });
  return { stateRef, handle: createSseEventHandler(deps), completed };
}

const story = (state: SessionState) =>
  state.messages.find((message) => message.id === "story-1");

describe("speakers of a story completed live", () => {
  it("shows nameplates and the speaking marker from the completion event", () => {
    const { stateRef, handle, completed } = liveSession();
    handle(completed({ segments }));
    const message = story(stateRef.current);
    expect(message?.segments).toEqual(segments);
    expect(storyParagraphSpeakers(message)).toEqual([null, "阿雅"]);
    expect(lastStorySpeaker(message)).toEqual({
      name: "阿雅",
      characterId: "char-aya",
    });
  });

  it("takes the committed segments from a later snapshot and keeps the live row", () => {
    const { stateRef, handle, completed } = liveSession();
    handle(completed({}));
    const live = story(stateRef.current);
    expect(live?.segments).toBeUndefined();
    expect(lastStorySpeaker(live)).toBeUndefined();

    const durable: StreamMessage = {
      id: "story-1",
      role: "assistant",
      content: "雨停了。\n\n「走吧。」",
      kind: "story",
      timestamp: "2026-10-30T00:00:00.500Z",
      turnId: "turn-1",
      runtimeId: "narrator",
      segments,
    };
    stateRef.current = reducer(stateRef.current, {
      type: "MERGE_RECOVERED_MESSAGES",
      messages: [durable],
    });
    const merged = story(stateRef.current);
    expect(merged).toEqual({ ...live, segments });
    expect(stateRef.current.messages).toHaveLength(1);
    expect(lastStorySpeaker(merged)?.name).toBe("阿雅");
  });

  it("drops malformed segments instead of showing them", () => {
    const { stateRef, handle, completed } = liveSession();
    handle(completed({ segments: [{ kind: "song", text: 3 }] }));
    expect(story(stateRef.current)?.segments).toBeUndefined();
    expect(story(stateRef.current)?.content).toBe("雨停了。\n\n「走吧。」");
  });
});
