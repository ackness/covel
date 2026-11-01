/**
 * Visit Markdown link/image destinations without reformatting the document.
 * Uses only Node built-ins: release assembly runs before dependency install.
 */

function maskCode(text) {
  let fence;
  let masked = "";
  for (const line of text.split(/(?<=\n)/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        marker[2].trim() === ""
      ) {
        fence = undefined;
      }
      masked += line.replace(/[^\n]/g, " ");
    } else if (marker) {
      fence = marker[1];
      masked += line.replace(/[^\n]/g, " ");
    } else masked += line;
  }
  return masked.replace(
    /<!--[\s\S]*?(?:-->|$)|(?<![\\`])(`+)([\s\S]*?)\1(?!`)/g,
    (code) => code.replace(/[^\n]/g, " "),
  );
}

function destinationAt(text, offset) {
  let start = offset;
  while (/\s/.test(text[start] ?? "") && start < text.length) start++;
  const angle = text[start] === "<";
  if (angle) start++;
  let depth = 0;
  let end = start;
  for (; end < text.length; end++) {
    const char = text[end];
    if (char === "\\") {
      end++;
      continue;
    }
    if (angle) {
      if (char === ">") return { start, end, after: end + 1 };
      if (char === "\n" || char === "<") return undefined;
    } else {
      if (char === "(") depth++;
      else if (char === ")") {
        if (depth === 0) break;
        depth--;
      } else if (/\s/.test(char)) break;
    }
  }
  return angle || depth !== 0 ? undefined : { start, end, after: end };
}

/** Inline links/images and reference definitions; code and comments are ignored. */
export function mapMarkdownDestinations(text, visit) {
  const masked = maskCode(text);
  const ranges = [];
  const skip = new Map();
  for (const match of masked.matchAll(
    /^ {0,3}\[(?:\\.|[^\]\\\n])+\]:[ \t]*(?:\n[ \t]*)?/gm,
  )) {
    const range = destinationAt(masked, match.index + match[0].length);
    if (range) {
      ranges.push(range);
      const lineEnd = masked.indexOf("\n", range.after);
      skip.set(match.index, lineEnd === -1 ? masked.length : lineEnd);
    }
  }
  for (let index = 0; index < masked.length; index++) {
    if (skip.has(index)) {
      index = skip.get(index) - 1;
      continue;
    }
    if (masked[index] === "\\") {
      index++;
      continue;
    }
    if (masked[index] !== "[") continue;
    let depth = 1;
    let close = index + 1;
    for (; close < masked.length; close++) {
      if (masked[close] === "\\") close++;
      else if (masked[close] === "[") depth++;
      else if (masked[close] === "]" && --depth === 0) break;
    }
    if (masked[close + 1] !== "(") continue;
    const range = destinationAt(masked, close + 2);
    if (!range) continue;
    // The destination may be followed by a title, then the link's closing `)`.
    const tail =
      /^\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))?\s*\)/.exec(
        masked.slice(range.after),
      );
    if (tail) {
      ranges.push(range);
      skip.set(close + 1, range.after + tail[0].length);
    }
  }
  let result = "";
  let offset = 0;
  for (const { start, end } of ranges.sort((a, b) => a.start - b.start)) {
    if (start < offset) continue;
    result += text.slice(offset, start) + visit(text.slice(start, end));
    offset = end;
  }
  return result + text.slice(offset);
}

/** The pathname of a relative destination, without its query or anchor. */
export function relativeLinkPath(destination) {
  if (!destination || /^(?:[a-z][a-z\d+.-]*:|\/|#|\?)/i.test(destination)) {
    return null;
  }
  return destination.split(/[?#]/, 1)[0];
}
