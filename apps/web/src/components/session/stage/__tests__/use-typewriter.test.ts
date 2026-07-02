import { describe, expect, it } from "vitest";
import {
  typewriterInit,
  typewriterReduce,
  type TypewriterState,
} from "../use-typewriter.js";

/** Test helper: keep ticking until the reducer leaves "typing". */
function ticksUntilPause(state: TypewriterState): TypewriterState {
  let next = state;
  // Generous bound — real segments are a handful of sentences, not 10k chars.
  for (let i = 0; i < 10_000 && next.status === "typing"; i += 1) {
    const after = typewriterReduce(next, { type: "tick" });
    if (after === next) break; // no more progress possible (waiting on more feed)
    next = after;
  }
  return next;
}

describe("typewriterInit", () => {
  it("starts idle with empty visible text", () => {
    const s = typewriterInit();
    expect(s.status).toBe("idle");
    expect(s.visible).toBe("");
    expect(s.streamEnded).toBe(false);
  });
});

describe("typewriterReduce", () => {
  it("1. feed() enters typing, ticks reveal chars, pauses at the segment boundary", () => {
    const s0 = typewriterInit();
    const s1 = typewriterReduce(s0, {
      type: "feed",
      text: "第一段。\n\n第二",
    });
    expect(s1.status).toBe("typing");
    expect(s1.visible).toBe("");

    const s2 = ticksUntilPause(s1);
    expect(s2.status).toBe("pause");
    expect(s2.visible).toBe("第一段。");
  });

  it("2. advance() from pause moves into the next segment (typing)", () => {
    const s1 = typewriterReduce(typewriterInit(), {
      type: "feed",
      text: "第一段。\n\n第二段",
    });
    const s2 = ticksUntilPause(s1);
    expect(s2.status).toBe("pause");

    const s3 = typewriterReduce(s2, { type: "advance" });
    expect(s3.status).toBe("typing");
    expect(s3.visible).toBe("");
  });

  it("3. skip() while typing instantly fills the current segment", () => {
    const s1 = typewriterReduce(typewriterInit(), {
      type: "feed",
      text: "第一段。\n\n第二段。\n\n第三段",
    });
    const s2 = typewriterReduce(s1, { type: "skip" });
    expect(s2.visible).toBe("第一段。");
    // There's a next segment (第二段。) — skip closes the boundary, so pause.
    expect(s2.status).toBe("pause");

    const s3 = typewriterReduce(s2, { type: "advance" });
    const s4 = typewriterReduce(s3, { type: "skip" });
    expect(s4.visible).toBe("第二段。");
    expect(s4.status).toBe("pause");
  });

  it("3b. skip() on the last known (still-open) segment follows the streamEnd rule", () => {
    const s1 = typewriterReduce(typewriterInit(), {
      type: "feed",
      text: "唯一段",
    });
    const skipped = typewriterReduce(s1, { type: "skip" });
    expect(skipped.visible).toBe("唯一段");
    // No streamEnd yet and no further segment — stays "typing" (waiting).
    expect(skipped.status).toBe("typing");

    const ended = typewriterReduce(skipped, { type: "streamEnd" });
    expect(ended.status).toBe("done");
  });

  it("4. running out of queued text before streamEnd waits in typing (not done); streamEnd then completes it", () => {
    const s1 = typewriterReduce(typewriterInit(), {
      type: "feed",
      text: "还在写",
    });
    const caughtUp = ticksUntilPause(s1);
    // Nothing left to reveal, no delimiter yet, no streamEnd — must not be "done".
    expect(caughtUp.status).toBe("typing");
    expect(caughtUp.visible).toBe("还在写");

    // Extra ticks while waiting must not misfire into "done" either.
    const stillWaiting = typewriterReduce(caughtUp, { type: "tick" });
    expect(stillWaiting.status).toBe("typing");

    const finished = typewriterReduce(stillWaiting, { type: "streamEnd" });
    expect(finished.status).toBe("done");
    expect(finished.visible).toBe("还在写");
  });

  it("5. skip only affects the current segment — a second click (pause) does not swallow the next one", () => {
    const s1 = typewriterReduce(typewriterInit(), {
      type: "feed",
      text: "第一段。\n\n第二段。\n\n第三段",
    });
    const skipped = typewriterReduce(s1, { type: "skip" });
    expect(skipped.status).toBe("pause");
    expect(skipped.visible).toBe("第一段。");

    // A second "click" while paused is routed to skip() again by mistake —
    // the reducer must ignore it (only advance() progresses from pause).
    const clickedAgain = typewriterReduce(skipped, { type: "skip" });
    expect(clickedAgain).toEqual(skipped);
    expect(clickedAgain.status).toBe("pause");

    const advanced = typewriterReduce(clickedAgain, { type: "advance" });
    expect(advanced.status).toBe("typing");
    expect(advanced.visible).toBe("");
  });

  it("6. reset(newTurnId) clears the state machine back to idle", () => {
    const s1 = typewriterReduce(typewriterInit(), {
      type: "feed",
      text: "第一段。\n\n第二段",
    });
    const s2 = ticksUntilPause(s1);
    expect(s2.status).toBe("pause");

    const reset = typewriterReduce(s2, {
      type: "reset",
      turnId: "turn-2",
    });
    expect(reset.status).toBe("idle");
    expect(reset.visible).toBe("");
    expect(reset.buffer).toBe("");
    expect(reset.turnId).toBe("turn-2");
  });

  it("streamEnd mid-reveal of the last segment must not jump straight to done", () => {
    const s1 = typewriterReduce(typewriterInit(), {
      type: "feed",
      text: "还在写的一段话",
    });
    // Only 2 of the segment's chars are shown — still typing, nowhere near caught up.
    const s2 = typewriterReduce(s1, { type: "tick" });
    const s3 = typewriterReduce(s2, { type: "tick" });
    expect(s3.visible).toBe("还在");
    expect(s3.status).toBe("typing");

    const ended = typewriterReduce(s3, { type: "streamEnd" });
    expect(ended.status).toBe("typing");
    expect(ended.streamEnded).toBe(true);
    expect(ended.visible).toBe("还在"); // unrevealed tail is untouched by streamEnd
  });

  it("advance() outside of pause is a no-op", () => {
    const idle = typewriterInit();
    expect(typewriterReduce(idle, { type: "advance" })).toEqual(idle);

    const typing = typewriterReduce(idle, { type: "feed", text: "第一段" });
    expect(typewriterReduce(typing, { type: "advance" })).toEqual(typing);

    const singleSegment = typewriterReduce(typewriterInit(), {
      type: "feed",
      text: "唯一段",
    });
    const done = typewriterReduce(ticksUntilPause(singleSegment), {
      type: "streamEnd",
    });
    expect(done.status).toBe("done");
    expect(typewriterReduce(done, { type: "advance" })).toEqual(done);
  });

  it("7. reducedMotion shows a fed segment fully at once but still pauses at the boundary", () => {
    const s1 = typewriterReduce(typewriterInit(true), {
      type: "feed",
      text: "第一段。\n\n第二段",
    });
    // No ticks needed — the whole first segment is visible immediately.
    expect(s1.visible).toBe("第一段。");
    expect(s1.status).toBe("pause");

    const s2 = typewriterReduce(s1, { type: "advance" });
    // Second segment is still open (no trailing \n\n yet, no streamEnd) —
    // reducedMotion reveals everything known so far and waits.
    expect(s2.visible).toBe("第二段");
    expect(s2.status).toBe("typing");
  });
});
