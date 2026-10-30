/**
 * Live text of a segmented story.
 *
 * A story runtime that asks for segments answers in JSON, and the player
 * should see the story while it is written, not the JSON. This wrapper sits
 * between the loop's delta forwarder and the request's `onDelta`, reads the
 * JSON incrementally, and forwards only the text values inside `segments`,
 * with the separators the committed `narrativeOutput` uses: a blank line
 * between segments, a blank line inside a text folded to one newline, and
 * each text trimmed (`normalizeSegmentText`). Speakers, cues and every other
 * value are never forwarded.
 *
 * A step whose first non-space character is not `{` is prose and passes
 * through unchanged, except a Markdown fence (```` ``` ```` or
 * ```` ```json ````) that opens a JSON object: the final-output parser and
 * the narrative review strip that fence and read the JSON, so the fence is
 * held until the next character shows whether JSON follows. A `reset` is forwarded and starts over. A second JSON
 * object after the first one closed is a new step (the last answer wins), so
 * the text shown so far is reset first.
 */
import type { AgentLoopDeps } from "../turn-executor/turn-executor-types.js";

type DeltaSink = NonNullable<AgentLoopDeps["onDelta"]>;
type DeltaEvent = Parameters<DeltaSink>[0];

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
  let anyText = false;

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
    anyText = false;
  };

  /** Inside `{ "segments": [ { "text": "…" } ] }` at the top level. */
  const atSegmentText = (): boolean => {
    const [root, list, segment] = stack;
    return (
      stack.length === 3 &&
      root?.type === "object" &&
      root.key === "segments" &&
      list?.type === "array" &&
      segment?.type === "object" &&
      segment.key === "text"
    );
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
      if (anyText) out += "\n\n";
      segmentHasText = true;
      anyText = true;
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
        streamString = !stringIsKey && atSegmentText();
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

  /** Visible text of one delta, and whether the shown text must be reset first. */
  const consume = (text: string): { out: string; reset: boolean } => {
    let out = "";
    let reset = false;
    for (let index = 0; index < text.length; index++) {
      const char = text[index]!;
      if (mode === "prose") return { out: out + text.slice(index), reset };
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
          return { out: out + rest, reset };
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
          return { out: out + rest, reset };
        }
        if (mode === "after") {
          // A new JSON answer replaces the one already shown.
          reset ||= anyText;
          out = "";
          clear();
        }
        mode = "json";
        heldSpace = "";
      }
      out += jsonChar(char);
    }
    return { out, reset };
  };

  return async (delta: DeltaEvent): Promise<void> => {
    if (delta.reset) clear();
    const { out, reset } = consume(delta.textDelta);
    if (!delta.reset && !reset && !out) return;
    await onDelta({
      runtimeId: delta.runtimeId,
      pluginId: delta.pluginId,
      textDelta: out,
      ...(delta.reset || reset ? { reset: true as const } : {}),
    });
  };
}
