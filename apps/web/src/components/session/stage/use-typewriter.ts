/**
 * Typewriter state machine for the stage dialog box (spec §3).
 *
 * `typewriterInit`/`typewriterReduce` are the pure state machine — the unit
 * under test. `useTypewriter` is a thin hook wrapper: it diffs newly
 * arrived stream text into `feed` events, drives `tick` off an interval,
 * and forwards `streamEnd`/`reset`.
 *
 * State machine: idle -[feed]-> typing -[reach segment boundary]-> pause
 * -[advance]-> typing -> ... -> done (last segment fully shown + streamEnd).
 * Segments are delimited by "\n\n" (3+ newlines collapse to one break).
 * `skip` instantly reveals the rest of the *current* segment only — it
 * never swallows an unread segment.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";

export type TypewriterStatus = "idle" | "typing" | "pause" | "done";

export interface TypewriterState {
  readonly status: TypewriterStatus;
  /** Full raw text received so far (all feeds concatenated). */
  readonly buffer: string;
  /** Index into `splitSegments(buffer)` of the segment being shown. */
  readonly segmentIndex: number;
  /** Characters of the current segment revealed so far. */
  readonly shownLen: number;
  /** Derived: `segments[segmentIndex].slice(0, shownLen)`. */
  readonly visible: string;
  readonly streamEnded: boolean;
  readonly reducedMotion: boolean;
  readonly turnId?: string;
}

export type TypewriterEvent =
  | { readonly type: "feed"; readonly text: string }
  | { readonly type: "tick" }
  | { readonly type: "advance" }
  | { readonly type: "skip" }
  | { readonly type: "streamEnd" }
  | {
      readonly type: "reset";
      readonly turnId?: string;
      readonly reducedMotion?: boolean;
    };

const PARAGRAPH_BREAK = "\n\n";

function splitSegments(buffer: string): string[] {
  return buffer.replace(/\n{3,}/g, PARAGRAPH_BREAK).split(PARAGRAPH_BREAK);
}

export function typewriterInit(reducedMotion = false): TypewriterState {
  return {
    status: "idle",
    buffer: "",
    segmentIndex: 0,
    shownLen: 0,
    visible: "",
    streamEnded: false,
    reducedMotion,
  };
}

export function typewriterReduce(
  state: TypewriterState,
  event: TypewriterEvent,
): TypewriterState {
  switch (event.type) {
    case "feed":
      return applyFeed(state, event.text);
    case "tick":
      return applyReveal(state, 1);
    case "advance":
      return applyAdvance(state);
    case "skip":
      return applySkip(state);
    case "streamEnd":
      return applyStreamEnd(state);
    case "reset":
      return {
        ...typewriterInit(event.reducedMotion ?? state.reducedMotion),
        turnId: event.turnId,
      };
    default:
      return state;
  }
}

function applyFeed(state: TypewriterState, text: string): TypewriterState {
  const buffer = state.buffer + text;
  const next: TypewriterState =
    state.status === "idle"
      ? { ...state, buffer, status: "typing" }
      : { ...state, buffer };
  // reducedMotion keeps segments fully revealed as soon as their text is
  // known, instead of waiting for per-char ticks (case 7).
  return next.reducedMotion && next.status === "typing"
    ? applyReveal(next, Infinity)
    : next;
}

/** Reveal up to `maxChars` more of the current segment; no-op unless typing. */
function applyReveal(
  state: TypewriterState,
  maxChars: number,
): TypewriterState {
  if (state.status !== "typing") return state;

  const segments = splitSegments(state.buffer);
  const segment = segments[state.segmentIndex] ?? "";
  const shownLen = Math.min(segment.length, state.shownLen + maxChars);
  const visible = segment.slice(0, shownLen);

  if (shownLen < segment.length) {
    return { ...state, shownLen, visible };
  }

  // Fully revealed. A non-last segment is always closed by a real "\n\n"
  // delimiter, so there is always a next segment worth pausing for. The
  // last known segment only "closes" once the stream has ended — until
  // then we're just caught up, waiting for more delta (still "typing").
  const isLastSegment = state.segmentIndex === segments.length - 1;
  if (!isLastSegment) {
    return { ...state, shownLen, visible, status: "pause" };
  }
  if (state.streamEnded) {
    return { ...state, shownLen, visible, status: "done" };
  }
  return { ...state, shownLen, visible };
}

function applyAdvance(state: TypewriterState): TypewriterState {
  if (state.status !== "pause") return state;
  const next: TypewriterState = {
    ...state,
    status: "typing",
    segmentIndex: state.segmentIndex + 1,
    shownLen: 0,
    visible: "",
  };
  return state.reducedMotion ? applyReveal(next, Infinity) : next;
}

function applySkip(state: TypewriterState): TypewriterState {
  if (state.status !== "typing") return state;
  return applyReveal(state, Infinity);
}

function applyStreamEnd(state: TypewriterState): TypewriterState {
  if (state.status !== "typing") return { ...state, streamEnded: true };

  const segments = splitSegments(state.buffer);
  const segment = segments[state.segmentIndex] ?? "";
  const isLastSegment = state.segmentIndex === segments.length - 1;
  const caughtUp = state.shownLen >= segment.length;

  return isLastSegment && caughtUp
    ? { ...state, streamEnded: true, status: "done" }
    : { ...state, streamEnded: true };
}

// ── Hook wrapper ─────────────────────────────────────────────────

const CHARS_PER_SECOND = 30;
const TICK_INTERVAL_MS = 1000 / CHARS_PER_SECOND;

export interface UseTypewriterOptions {
  readonly turnId?: string;
  readonly reducedMotion?: boolean;
}

export interface UseTypewriterResult {
  readonly visible: string;
  readonly status: TypewriterStatus;
  readonly advance: () => void;
  readonly skip: () => void;
}

/**
 * Drives `typewriterReduce` off real stream text. `streamText` is expected
 * to grow monotonically within a turn (SSE deltas); a full replacement
 * (e.g. `narrative.completed` swapping in the final text) is also handled —
 * anything that isn't a simple append re-feeds the whole new text.
 */
export function useTypewriter(
  streamText: string,
  streamEnded: boolean,
  opts: UseTypewriterOptions = {},
): UseTypewriterResult {
  const reducedMotion = opts.reducedMotion ?? false;
  const [state, dispatch] = useReducer(
    typewriterReduce,
    reducedMotion,
    typewriterInit,
  );
  const turnIdRef = useRef(opts.turnId);
  const fedTextRef = useRef("");

  useEffect(() => {
    if (opts.turnId === turnIdRef.current) return;
    turnIdRef.current = opts.turnId;
    fedTextRef.current = "";
    dispatch({ type: "reset", turnId: opts.turnId, reducedMotion });
  }, [opts.turnId, reducedMotion]);

  useEffect(() => {
    if (streamText === fedTextRef.current) return;
    const delta = streamText.startsWith(fedTextRef.current)
      ? streamText.slice(fedTextRef.current.length)
      : streamText;
    fedTextRef.current = streamText;
    if (delta) dispatch({ type: "feed", text: delta });
  }, [streamText]);

  // `opts.turnId` is a dependency even though it isn't read here: a turnId
  // change fires `reset` (above), which clears the internal streamEnded flag.
  // When an already-complete turn is hydrated (session restore), the
  // streamEnded PROP is level-true and never edges, so without re-running on
  // turnId this stays cleared — the last segment never resolves to "done" and
  // the stage choice overlay / composer stay gated forever.
  useEffect(() => {
    if (streamEnded) dispatch({ type: "streamEnd" });
  }, [streamEnded, opts.turnId]);

  useEffect(() => {
    if (reducedMotion || state.status !== "typing") return;
    const id = setInterval(() => dispatch({ type: "tick" }), TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [reducedMotion, state.status]);

  const advance = useCallback(() => dispatch({ type: "advance" }), []);
  const skip = useCallback(() => dispatch({ type: "skip" }), []);

  return { visible: state.visible, status: state.status, advance, skip };
}
