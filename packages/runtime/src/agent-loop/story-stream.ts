/**
 * Live text of a segmented story.
 *
 * A story runtime that asks for segments answers in JSON, and the player
 * should see the story while it is written, not the JSON. This wrapper sits
 * between the loop's delta forwarder and the request's `onDelta`, reads the
 * JSON incrementally, and forwards only the text values inside `segments`,
 * with the separators the committed `narrativeOutput` uses: a blank line
 * between segments, a blank line inside a text folded to one newline, and
 * each text trimmed (`normalizeSegmentText`). Cues and every other value
 * outside a segment are never forwarded.
 *
 * Each paragraph also carries its metadata (`segment`: index, kind, speaker
 * as written), under the lenient rules the committed story uses: an unknown
 * kind is narration, narration has no speaker, and a speaker is trimmed and
 * cut to the speaker limit. The event that carries a paragraph's first
 * visible character carries what is known of its segment; a `kind` or
 * `speaker` that closes later is sent as one more event with no text. A
 * segment without visible text has no paragraph and sends nothing.
 *
 * A step whose first non-space character is not `{` is prose and passes
 * through unchanged, except a Markdown fence (```` ``` ```` or
 * ```` ```json ````) that opens a JSON object: the final-output parser and
 * the narrative review strip that fence and read the JSON, so the fence is
 * held until the next character shows whether JSON follows. A `reset` is forwarded and starts over. A second JSON
 * object after the first one closed is a new step (the last answer wins), so
 * the text shown so far is reset first.
 */
import {
  STORY_LIMITS,
  storySegmentKinds,
  type NarrativeDeltaSegment,
  type StorySegmentKind,
} from "@covel/shared";
import type { AgentLoopDeps } from "../turn-executor/turn-executor-types.js";

type DeltaSink = NonNullable<AgentLoopDeps["onDelta"]>;
type DeltaEvent = Parameters<DeltaSink>[0];

/** One event to forward: text, and the paragraph metadata it starts or updates. */
interface Chunk {
  text: string;
  readonly segment?: NarrativeDeltaSegment;
  /** A metadata update; later text goes to a new event. */
  readonly metaOnly?: true;
}

const isKind = (value: string | undefined): value is StorySegmentKind =>
  (storySegmentKinds as readonly (string | undefined)[]).includes(value);

/** The metadata of paragraph `index`, as the committed story would read it. */
function segmentMeta(
  index: number,
  kind: string | undefined,
  speaker: string | undefined,
): NarrativeDeltaSegment {
  const resolvedKind = isKind(kind) ? kind : "narration";
  const name =
    resolvedKind === "narration" || speaker === undefined
      ? ""
      : [...speaker.trim()].slice(0, STORY_LIMITS.speaker).join("");
  return { index, kind: resolvedKind, ...(name ? { speaker: name } : {}) };
}

const sameMeta = (
  a: NarrativeDeltaSegment | undefined,
  b: NarrativeDeltaSegment,
): boolean => a?.kind === b.kind && a.speaker === b.speaker;

type Container =
  | { readonly type: "array" }
  | { readonly type: "object"; key: string | undefined; expectKey: boolean };

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

const isSpace = (char: string): boolean => /\s/.test(char);

/** A held text that may still become a supported fence before a JSON object. */
const FENCE_PREFIX = /^(?:`{1,3}|```(?:j|js|jso|json)|```(?:json)?\s+)$/i;
/** A complete fence opener: the next `{` starts the JSON answer. */
const FENCE_OPEN = /^```(?:json)?\s*$/i;

export function createStorySegmentStream(onDelta: DeltaSink): DeltaSink {
  let mode: "start" | "prose" | "json" | "after" = "start";
  let heldSpace = "";
  let fence = "";
  let stack: Container[] = [];
  let inString = false;
  let stringIsKey = false;
  let streamString = false;
  let keyBuffer = "";
  let escaping = false;
  let unicode: string | undefined;
  let pendingHigh: number | undefined;
  let segmentHasText = false;
  let pendingSpace = "";
  /** Visible paragraphs so far; the next one gets this index. */
  let paragraphs = 0;
  // The segment object being read: its kind and speaker as written, the
  // paragraph its text started, and the metadata last sent for it.
  let segmentKind: string | undefined;
  let segmentSpeaker: string | undefined;
  let segmentParagraph: number | undefined;
  let segmentSent: NarrativeDeltaSegment | undefined;
  /** The segment value being read (`kind` or `speaker`), and its text. */
  let capture: "kind" | "speaker" | undefined;
  let captured = "";
  let chunks: Chunk[] = [];

  const clear = (): void => {
    mode = "start";
    heldSpace = "";
    fence = "";
    stack = [];
    inString = false;
    stringIsKey = false;
    streamString = false;
    keyBuffer = "";
    escaping = false;
    unicode = undefined;
    pendingHigh = undefined;
    segmentHasText = false;
    pendingSpace = "";
    paragraphs = 0;
    startSegment();
  };

  const startSegment = (): void => {
    segmentKind = undefined;
    segmentSpeaker = undefined;
    segmentParagraph = undefined;
    segmentSent = undefined;
    capture = undefined;
    captured = "";
  };

  const emit = (text: string): void => {
    if (!text) return;
    const last = chunks.at(-1);
    if (last && !last.metaOnly) last.text += text;
    else chunks.push({ text });
  };

  /** Inside a segment object of `{ "segments": [ { … } ] }` at the top level. */
  const inSegment = (): boolean => {
    const [root, list, segment] = stack;
    return (
      stack.length === 3 &&
      root?.type === "object" &&
      root.key === "segments" &&
      list?.type === "array" &&
      segment?.type === "object"
    );
  };

  /** The key of the segment value being opened, when inside a segment. */
  const segmentKey = (): string | undefined => {
    const segment = stack[2];
    return inSegment() && segment?.type === "object" ? segment.key : undefined;
  };

  /** A segment's `kind` or `speaker` closed: resend its paragraph's metadata. */
  const segmentValueClosed = (): void => {
    if (capture === "kind") segmentKind = captured;
    else segmentSpeaker = captured;
    capture = undefined;
    captured = "";
    if (segmentParagraph === undefined) return;
    const meta = segmentMeta(segmentParagraph, segmentKind, segmentSpeaker);
    if (sameMeta(segmentSent, meta)) return;
    segmentSent = meta;
    chunks.push({ text: "", segment: meta, metaOnly: true });
  };

  /** Process one character of a JSON step; returns the visible text it adds. */
  const textChar = (char: string): string => {
    if (isSpace(char)) {
      // Leading space of a text is trimmed; inner space waits for the next
      // visible character, so trailing space is trimmed too.
      if (segmentHasText) pendingSpace += char;
      return "";
    }
    let out = "";
    if (!segmentHasText) {
      // A new paragraph: its event starts here, with what is known so far.
      if (paragraphs > 0) out += "\n\n";
      segmentHasText = true;
      segmentParagraph = paragraphs++;
      segmentSent = segmentMeta(segmentParagraph, segmentKind, segmentSpeaker);
      chunks.push({ text: "", segment: segmentSent });
    } else if (pendingSpace) {
      out += pendingSpace.replace(/\n{2,}/g, "\n");
    }
    pendingSpace = "";
    return out + char;
  };

  const stringChar = (char: string): string => {
    if (pendingHigh !== undefined) {
      // A lone high surrogate escape is kept as it was written.
      const high = String.fromCharCode(pendingHigh);
      pendingHigh = undefined;
      return stringChar(high) + stringChar(char);
    }
    if (stringIsKey) {
      keyBuffer += char;
      return "";
    }
    if (capture) captured += char;
    return streamString ? textChar(char) : "";
  };

  const codeUnit = (code: number): string => {
    if (code >= 0xd800 && code <= 0xdbff && pendingHigh === undefined) {
      pendingHigh = code;
      return "";
    }
    if (code >= 0xdc00 && code <= 0xdfff && pendingHigh !== undefined) {
      const pair = String.fromCharCode(pendingHigh, code);
      pendingHigh = undefined;
      if (stringIsKey) {
        keyBuffer += pair;
        return "";
      }
      if (capture) captured += pair;
      return streamString ? textChar(pair) : "";
    }
    return stringChar(String.fromCharCode(code));
  };

  const jsonChar = (char: string): string => {
    if (inString) {
      if (unicode !== undefined) {
        unicode += char;
        if (unicode.length < 4) return "";
        const code = Number.parseInt(unicode, 16);
        unicode = undefined;
        escaping = false;
        return Number.isNaN(code) ? "" : codeUnit(code);
      }
      if (escaping) {
        if (char === "u") {
          unicode = "";
          return "";
        }
        escaping = false;
        return stringChar(ESCAPES[char] ?? char);
      }
      if (char === "\\") {
        escaping = true;
        return "";
      }
      if (char === '"') {
        let out = "";
        if (pendingHigh !== undefined) {
          const high = String.fromCharCode(pendingHigh);
          pendingHigh = undefined;
          out = stringChar(high);
        }
        inString = false;
        const top = stack.at(-1);
        if (stringIsKey && top?.type === "object") top.key = keyBuffer;
        if (capture) segmentValueClosed();
        // Trailing space of a text is trimmed.
        if (streamString) pendingSpace = "";
        streamString = false;
        return out;
      }
      return stringChar(char);
    }
    const top = stack.at(-1);
    switch (char) {
      case "{":
        stack.push({ type: "object", key: undefined, expectKey: true });
        if (inSegment()) startSegment();
        return "";
      case "[":
        stack.push({ type: "array" });
        return "";
      case "}":
      case "]":
        stack.pop();
        if (stack.length === 0) mode = "after";
        return "";
      case '"':
        inString = true;
        stringIsKey = top?.type === "object" && top.expectKey;
        keyBuffer = "";
        {
          const key = stringIsKey ? undefined : segmentKey();
          streamString = key === "text";
          capture = key === "kind" || key === "speaker" ? key : undefined;
          captured = "";
        }
        if (streamString) {
          segmentHasText = false;
          pendingSpace = "";
        }
        return "";
      case ":":
        if (top?.type === "object") top.expectKey = false;
        return "";
      case ",":
        if (top?.type === "object") {
          top.expectKey = true;
          top.key = undefined;
        }
        return "";
      default:
        return "";
    }
  };

  /**
   * Read one delta into `chunks`; returns whether the shown text must be
   * reset first.
   */
  const consume = (text: string): boolean => {
    let reset = false;
    for (let index = 0; index < text.length; index++) {
      const char = text[index]!;
      if (mode === "prose") {
        emit(text.slice(index));
        return reset;
      }
      if (mode === "start" && (fence || char === "`")) {
        if (FENCE_PREFIX.test(fence + char)) {
          fence += char;
          continue;
        }
        if (char !== "{" || !FENCE_OPEN.test(fence)) {
          // Not a fence around JSON: everything held is prose.
          mode = "prose";
          const rest = heldSpace + fence + text.slice(index);
          heldSpace = "";
          fence = "";
          emit(rest);
          return reset;
        }
        // The closing fence lands in the "after" mode, which ignores it.
        fence = "";
      }
      if (mode === "start" || mode === "after") {
        if (isSpace(char)) {
          if (mode === "start") heldSpace += char;
          continue;
        }
        if (char !== "{") {
          if (mode === "after") continue;
          mode = "prose";
          const rest = heldSpace + text.slice(index);
          heldSpace = "";
          emit(rest);
          return reset;
        }
        if (mode === "after") {
          // A new JSON answer replaces the one already shown.
          reset ||= paragraphs > 0;
          chunks = [];
          clear();
        }
        mode = "json";
        heldSpace = "";
      }
      // Read the piece first: a new paragraph opens its own chunk.
      const piece = jsonChar(char);
      emit(piece);
    }
    return reset;
  };

  return async (delta: DeltaEvent): Promise<void> => {
    if (delta.reset) clear();
    chunks = [];
    const reset = consume(delta.textDelta) || delta.reset === true;
    const events = chunks.filter((chunk) => chunk.text || chunk.segment);
    chunks = [];
    if (events.length === 0) {
      if (!reset) return;
      events.push({ text: "" });
    }
    for (const [index, chunk] of events.entries())
      await onDelta({
        runtimeId: delta.runtimeId,
        pluginId: delta.pluginId,
        textDelta: chunk.text,
        ...(reset && index === 0 ? { reset: true as const } : {}),
        ...(chunk.segment ? { segment: chunk.segment } : {}),
      });
  };
}
