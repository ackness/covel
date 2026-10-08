/**
 * Reasoning that a model writes inline in its reply as `<think>…</think>`.
 *
 * Some models reason in the reply itself (Qwen3, DeepSeek-R1 and their
 * distills), and an OpenAI-compatible gateway may pass that through as plain
 * content instead of a reasoning field. Left in the text, a story would show
 * the reasoning to the player and a JSON reply would not parse. The split
 * moves it to the reasoning channel, as AI SDK's `extractReasoningMiddleware`
 * does. A block left open (the reply was cut) is reasoning to the end.
 */

const OPEN = "<think>";
const CLOSE = "</think>";

export interface ThinkPart {
  readonly type: "text" | "reasoning";
  readonly text: string;
}

export interface ThinkTagSplitter {
  /** Split the next streamed piece; a possible partial tag is held back. */
  push(delta: string): ThinkPart[];
  /** Release what was held back once the stream has ended. */
  flush(): ThinkPart[];
  /** Whether any `<think>` block was seen. */
  readonly sawThink: boolean;
}

export function createThinkTagSplitter(): ThinkTagSplitter {
  let inThink = false;
  let sawThink = false;
  let buffer = "";
  // The newlines that separate a block from what follows are layout, not text.
  let trimLeading = false;

  const emit = (parts: ThinkPart[], text: string): void => {
    let value = text;
    if (trimLeading) {
      value = value.replace(/^\s+/, "");
      if (!value) return;
      trimLeading = false;
    }
    if (!value) return;
    const type = inThink ? "reasoning" : "text";
    const last = parts.at(-1);
    if (last?.type === type)
      parts[parts.length - 1] = { type, text: last.text + value };
    else parts.push({ type, text: value });
  };

  return {
    push(delta) {
      const parts: ThinkPart[] = [];
      buffer += delta;
      for (;;) {
        const tag = inThink ? CLOSE : OPEN;
        const at = buffer.indexOf(tag);
        if (at >= 0) {
          emit(parts, buffer.slice(0, at));
          buffer = buffer.slice(at + tag.length);
          inThink = !inThink;
          if (inThink) sawThink = true;
          trimLeading = true;
          continue;
        }
        const held = partialTagLength(buffer, tag);
        emit(parts, buffer.slice(0, buffer.length - held));
        buffer = buffer.slice(buffer.length - held);
        return parts;
      }
    },
    flush() {
      const parts: ThinkPart[] = [];
      emit(parts, buffer);
      buffer = "";
      return parts;
    },
    get sawThink() {
      return sawThink;
    },
  };
}

/** Split a whole reply into its text and the reasoning written inline. */
export function splitThinkTags(content: string): {
  readonly text: string;
  readonly reasoning: string;
  readonly sawThink: boolean;
} {
  const splitter = createThinkTagSplitter();
  // A tag prefix held back at the end comes out of flush() as its own part.
  const parts = [...splitter.push(content), ...splitter.flush()].reduce<
    ThinkPart[]
  >((merged, part) => {
    const last = merged.at(-1);
    if (last?.type === part.type)
      merged[merged.length - 1] = {
        type: part.type,
        text: last.text + part.text,
      };
    else merged.push(part);
    return merged;
  }, []);
  const join = (type: ThinkPart["type"]) =>
    parts
      .filter((part) => part.type === type)
      .map((part) => part.text)
      .join("\n");
  return {
    text: join("text"),
    reasoning: join("reasoning"),
    sawThink: splitter.sawThink,
  };
}

/** Length of the longest end of `text` that could start `tag`. */
function partialTagLength(text: string, tag: string): number {
  for (
    let length = Math.min(tag.length - 1, text.length);
    length > 0;
    length--
  ) {
    if (tag.startsWith(text.slice(text.length - length))) return length;
  }
  return 0;
}

/** Reasoning from a wire field and from inline `<think>` blocks, together. */
export function joinReasoning(
  ...texts: (string | undefined)[]
): string | undefined {
  const joined = texts.filter(Boolean).join("\n");
  return joined || undefined;
}
