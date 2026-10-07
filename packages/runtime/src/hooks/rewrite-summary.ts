/**
 * What the `hook.rewrote` trace says about a replacement: the replaced keys,
 * each with a short description of its value before and after. The values
 * themselves stay out. A PreLLMCall rewrite replaces the whole message list,
 * and two full copies of every request outweighed the rest of the trace.
 */

/** Longest preview of one value, in characters. */
const PREVIEW_CHARS = 200;
/** Nesting below this depth is shown as `[…]` / `{…}`; it also ends a cycle. */
const PREVIEW_DEPTH = 5;

export interface ReplacedValueSummary {
  /** Compact JSON-like text of the value, cut at the preview length. */
  readonly preview: string;
  /** Characters of a string or entries of an array. */
  readonly length?: number;
}

export type ReplacementSummary = Record<
  string,
  {
    readonly before: ReplacedValueSummary;
    readonly after: ReplacedValueSummary;
  }
>;

export function describeReplacement(
  payload: unknown,
  replace: Readonly<Record<string, unknown>>,
): ReplacementSummary {
  const previous =
    payload !== null && typeof payload === "object"
      ? (payload as Readonly<Record<string, unknown>>)
      : {};
  return Object.fromEntries(
    Object.keys(replace).map((key) => [
      key,
      { before: summarize(previous[key]), after: summarize(replace[key]) },
    ]),
  );
}

function summarize(value: unknown): ReplacedValueSummary {
  return {
    preview: preview(value),
    ...(typeof value === "string" || Array.isArray(value)
      ? { length: value.length }
      : {}),
  };
}

/** The first `count` characters of `text`, never half of a surrogate pair. */
function head(text: string, count: number): string {
  const last = text.charCodeAt(count - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? count - 1 : count);
}

/**
 * The walk stops once the preview is full, so a long prompt costs no more
 * than a short one.
 */
function preview(value: unknown): string {
  let text = "";
  const write = (current: unknown, depth: number): void => {
    if (text.length > PREVIEW_CHARS) return;
    if (typeof current === "string") {
      text += JSON.stringify(head(current, PREVIEW_CHARS));
    } else if (current === null || typeof current !== "object") {
      text += String(current);
    } else if (current instanceof Map || current instanceof Set) {
      text += `${current instanceof Map ? "Map" : "Set"}(${current.size})`;
    } else if (current instanceof ArrayBuffer || ArrayBuffer.isView(current)) {
      text += `bytes(${current.byteLength})`;
    } else if (current instanceof Date || current instanceof RegExp) {
      text += String(current);
    } else if (depth >= PREVIEW_DEPTH) {
      text += Array.isArray(current) ? "[…]" : "{…}";
    } else if (Array.isArray(current)) {
      text += "[";
      for (let index = 0; index < current.length; index += 1) {
        if (text.length > PREVIEW_CHARS) break;
        if (index > 0) text += ",";
        write(current[index], depth + 1);
      }
      text += "]";
    } else {
      text += "{";
      let first = true;
      for (const key of Object.keys(current)) {
        if (text.length > PREVIEW_CHARS) break;
        if (!first) text += ",";
        first = false;
        text += `${JSON.stringify(key)}:`;
        write((current as Readonly<Record<string, unknown>>)[key], depth + 1);
      }
      text += "}";
    }
  };
  write(value, 0);
  return text.length > PREVIEW_CHARS ? `${head(text, PREVIEW_CHARS)}…` : text;
}
