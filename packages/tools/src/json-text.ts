/**
 * Parsing of JSON a model wrote: the arguments of a tool call, and an array
 * or object it sent as text inside one. A few slips come back in run after
 * run and have one meaning each, so they are settled here instead of costing
 * another model call. Anything else fails with the parser's own reason.
 */

/** How many closing brackets after a complete JSON value are dropped. */
const EXTRA_CLOSERS = 4;

/** A quote that ends a JSON string is followed by one of these, or by the end. */
const AFTER_STRING = new Set([",", "}", "]", ":"]);

const NOT_PARSED = Symbol("not parsed");

/**
 * Parse text that may end with closing brackets it does not need.
 *
 * A model often closes one level more than it opened: `[{"id":1}]}` inside
 * a field, `{"updates":[…]}]}` as a whole argument string. The value before
 * the extra brackets is complete, so they are dropped: nothing inside the
 * value changes.
 */
function withoutExtraClosers(text: string): unknown {
  let rest = text.trimEnd();
  for (let dropped = 0; dropped <= EXTRA_CLOSERS; dropped += 1) {
    try {
      return JSON.parse(rest);
    } catch {
      if (!/[\]}]$/.test(rest)) break;
      rest = rest.slice(0, -1).trimEnd();
    }
  }
  return NOT_PARSED;
}

const nextAfterSpace = (text: string, from: number): number => {
  let index = from;
  while (index < text.length && /\s/.test(text[index]!)) index += 1;
  return index;
};

/**
 * Escape quote marks that stand inside a string value. Returns undefined
 * when the text has none that can be escaped safely.
 *
 * A model that quotes a word or a line of speech inside a value often writes
 * the quote marks bare: `"note": "The page calls it a "lock" and not a lamp."`.
 * The quote that ends a JSON string is followed by `,`, `}`, `]`, `:` or the
 * end of the text. A quote followed by other text belongs to the value. So
 * does the first of two quotes when the second ends the string
 * (`"She said "no""`).
 *
 * The text is left alone, and then fails as it did before, when that reading
 * is not the only one:
 * - The marks in one string do not come in pairs. One quote too many or too
 *   few is a fault in the structure (`{"{"id": …`, `"name": "Mira"", …`),
 *   not quoted text.
 * - The string is a key. A key that changes is a field that is lost.
 * - A quote is followed by another quote and more text. That is a missing
 *   comma between two strings: joining them moves a field into its
 *   neighbour.
 * A bare quote followed by `,` or `:` reads as the end of the string.
 */
function escapeInnerQuotes(text: string): string | undefined {
  let out = "";
  let inString = false;
  let escapedHere = 0;
  let escaped = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (!inString) {
      if (char === '"') {
        inString = true;
        escapedHere = 0;
      }
      out += char;
      continue;
    }
    if (char === "\\") {
      out += char + (text[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (char !== '"') {
      out += char;
      continue;
    }
    const next = nextAfterSpace(text, i + 1);
    const after = text[next];
    const ends = after === undefined || AFTER_STRING.has(after);
    // `…"no""` before a terminator: this quote closes the quoted word, the
    // next one closes the string.
    const closesQuotedText =
      after === '"' && next === i + 1 && endsString(text, next);
    if (ends || (after === '"' && !closesQuotedText)) {
      if (escapedHere > 0 && (escapedHere % 2 === 1 || after === ":"))
        return undefined;
      inString = false;
      out += char;
    } else {
      escapedHere += 1;
      escaped += 1;
      out += '\\"';
    }
  }
  return escaped > 0 ? out : undefined;
}

/** Is the quote at `index` followed by what follows the end of a JSON string? */
function endsString(text: string, index: number): boolean {
  const after = text[nextAfterSpace(text, index + 1)];
  return after === undefined || AFTER_STRING.has(after);
}

/**
 * Close an object that was left open where the next element of its array
 * starts. Returns undefined when the text has no such place.
 *
 * `[{"id":"a","attributes":{"kind":"lamp"}, {"id":"b"}]`: the model closed
 * `attributes` and went on to the next element without closing the first.
 * Inside an object a comma is followed by a key, so a `{` there cannot
 * belong to the object. If the object is an element of an array, the `{`
 * starts the next element, and the missing `}` goes before the comma.
 *
 * The other reading of the same place is a key that was left out
 * (`"summary":"…", {"role":"…"}}]`). Only one of the two has every bracket it
 * needs: the caller accepts the result only when it parses as it is, with no
 * other change, so a text written the other way stays an error.
 */
function closeOpenElements(text: string): string | undefined {
  const open: ("{" | "[")[] = [];
  // Index of the last comma, while nothing but white space has followed it.
  let comma = -1;
  // Commas that a `}` goes in front of.
  const missing: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (/\s/.test(char)) continue;
    if (char === '"') {
      for (i += 1; i < text.length && text[i] !== '"'; i += 1)
        if (text[i] === "\\") i += 1;
      comma = -1;
      continue;
    }
    if (
      char === "{" &&
      comma >= 0 &&
      open.at(-1) === "{" &&
      open.at(-2) === "["
    ) {
      missing.push(comma);
      open.pop();
    }
    if (char === "{" || char === "[") open.push(char);
    else if (char === "}" || char === "]") open.pop();
    comma = char === "," ? i : -1;
  }
  if (missing.length === 0) return undefined;
  let out = "";
  let from = 0;
  for (const at of missing) {
    out += `${text.slice(from, at)}}`;
    from = at;
  }
  return out + text.slice(from);
}

/**
 * Settle a closing bracket that does not match the bracket that is open.
 * Returns undefined when the text has none.
 *
 * `[{"id":"a"},{"id":"b"}}]`: a `}` where no object is open. Left out, the
 * text is complete. At the very end of the text the wrong bracket stands
 * where the right one belongs (`[{"id":"a"},{"id":"b"}}`), and the right one
 * takes its place. In both cases no value changes, and nothing is added that
 * the text does not have.
 *
 * With `closeAtEnd`, the brackets still open at the end of the text are
 * closed as well (`[{"id":"a"},{"id":"b"}`). That is only safe for text the
 * model ended itself: see `parseJsonText`.
 *
 * The caller accepts the result only when it parses as it is. A text that
 * lacks a bracket elsewhere, or has the wrong one in the middle, stays an
 * error.
 */
function withMatchingClosers(
  text: string,
  closeAtEnd: boolean,
): string | undefined {
  const open: ("{" | "[")[] = [];
  let out = "";
  let changed = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === '"') {
      let end = i + 1;
      for (; end < text.length && text[end] !== '"'; end += 1)
        if (text[end] === "\\") end += 1;
      out += text.slice(i, end + 1);
      i = end;
      continue;
    }
    if (char === "{" || char === "[") open.push(char);
    else if (char === "}" || char === "]") {
      const top = open.at(-1);
      const matching = top === "{" ? "}" : top === "[" ? "]" : undefined;
      if (matching !== undefined && char !== matching) {
        changed = true;
        if (text.slice(i + 1).trim() === "") {
          out += matching;
          open.pop();
        }
        continue;
      }
      open.pop();
    }
    out += char;
  }
  if (closeAtEnd && open.length > 0) {
    changed = true;
    out =
      out.trimEnd() +
      open
        .reverse()
        .map((bracket) => (bracket === "{" ? "}" : "]"))
        .join("");
  }
  return changed ? out : undefined;
}

/**
 * Write the opening of an object once where the model wrote it twice.
 * Returns undefined when the text has no such place.
 *
 * `[{"id":"a"},{"{"id":"b"}]`: the second element starts with `{"{"`. No
 * JSON has `{"{"` before a key name, and the text has the brackets of one
 * object there, so the second `{"` is a repetition. The caller accepts the
 * result only when it parses as it is.
 */
function withoutRepeatedOpening(text: string): string | undefined {
  let out = "";
  let changed = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (
      char === "{" &&
      text.startsWith('"{"', i + 1) &&
      /[\p{L}_]/u.test(text[i + 4] ?? "")
    ) {
      // Keep `{`, drop `"{`: the next quote opens the key.
      out += char;
      i += 2;
      changed = true;
      continue;
    }
    if (char === '"') {
      let end = i + 1;
      for (; end < text.length && text[end] !== '"'; end += 1)
        if (text[end] === "\\") end += 1;
      out += text.slice(i, end + 1);
      i = end;
      continue;
    }
    out += char;
  }
  return changed ? out : undefined;
}

/**
 * Parse JSON text written by a model. Accepts valid JSON as it is. Otherwise
 * it settles these slips and parses again: closing brackets after a complete
 * value, quote marks that stand inside a string value, an array element left
 * open where the next one starts, a closing bracket that does not match the
 * one that is open, and the opening of an object written twice. Each of the
 * last three is tried alone: together they would read a text with a missing
 * key as two elements. Throws the original parse error when the text is
 * broken in any other way; no other bracket is guessed at.
 *
 * `complete` says that the model ended the text itself: it is a string value
 * inside arguments that parsed. Brackets that are still open at its end are
 * then closed. The whole argument string never gets them: it can be output
 * that was cut off, and a value that was cut off must fail.
 */
export function parseJsonText(
  text: string,
  options?: { readonly complete?: boolean },
): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    for (const candidate of [text, escapeInnerQuotes(text)]) {
      if (candidate === undefined) continue;
      const value = withoutExtraClosers(candidate);
      if (value !== NOT_PARSED) return value;
      for (const settled of [
        closeOpenElements(candidate),
        withMatchingClosers(candidate, options?.complete === true),
        withoutRepeatedOpening(candidate),
      ]) {
        if (settled === undefined) continue;
        try {
          return JSON.parse(settled);
        } catch {
          // The brackets do not add up for this reading: not this slip.
        }
      }
    }
    throw error;
  }
}
