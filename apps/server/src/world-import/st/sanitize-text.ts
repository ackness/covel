/** Treat markup as text, never as a DOM or an executable template. */
function sanitizePass(input: string): { text: string; removed: number } {
  let removed = 0;
  let text = input
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\uD800-\uDFFF]/gu, "");
  text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, () => {
    removed++;
    return "";
  });
  // Scan fixed tag names. Unclosed active containers consume the rest of the text.
  const blocked = new Set([
    "script",
    "style",
    "iframe",
    "object",
    "embed",
    "link",
    "meta",
    "form",
    "svg",
    "math",
    "img",
  ]);
  const voidTags = new Set(["embed", "link", "meta", "img"]);
  const tags = /<\/?([a-z][a-z0-9:-]*)\b/gi;
  const absentClosings = new Set<string>();
  let result = "";
  let cursor = 0;
  for (let match = tags.exec(text); match; match = tags.exec(text)) {
    result += text.slice(cursor, match.index);
    const tag = match[1]!.toLowerCase();
    removed++;
    const tagEnd = text.indexOf(">", tags.lastIndex);
    if (tagEnd < 0) {
      cursor = text.length;
      break;
    }
    cursor = tagEnd + 1;
    const selfClosing = text[tagEnd - 1] === "/";
    tags.lastIndex = cursor;
    if (blocked.has(tag) && !match[0].startsWith("</")) {
      // The expression is built only from our fixed allowlisted tag names.
      const closing = new RegExp(`</${tag}\\s*>`, "gi");
      closing.lastIndex = cursor;
      const end = absentClosings.has(tag) ? null : closing.exec(text);
      if (!end) absentClosings.add(tag);
      if (end) cursor = closing.lastIndex;
      else if (!voidTags.has(tag) && !selfClosing) cursor = text.length;
      tags.lastIndex = cursor;
    } else if (tag === "br") result += "\n";
    else if (tag === "p") result += "\n\n";
  }
  text = result + text.slice(cursor);
  // Consume balanced target parentheses, including javascript:alert(...).
  const dangerousLink =
    /!?\[([^[\]\n]*)\]\(\s*<?(?:javascript|data|vbscript):/gi;
  result = "";
  cursor = 0;
  for (
    let match = dangerousLink.exec(text);
    match;
    match = dangerousLink.exec(text)
  ) {
    result += text.slice(cursor, match.index) + match[1];
    let depth = 1;
    let end = dangerousLink.lastIndex;
    for (; end < text.length && depth > 0; end++) {
      if (text[end] === "(") depth++;
      else if (text[end] === ")") depth--;
    }
    removed++;
    cursor = end;
    dangerousLink.lastIndex = end;
  }
  text = result + text.slice(cursor);
  text = text.replace(/^(\s*)---(?=\n|$)/, "$1- - -");
  return { text, removed };
}

export function sanitizeText(input: string): { text: string; removed: number } {
  let result = sanitizePass(input);
  let removed = result.removed;
  // Each changing pass removes characters. The cap bounds pathological nesting;
  // remaining angle brackets are discarded after it, never rendered as markup.
  for (let pass = 0; pass < 8; pass++) {
    const next = sanitizePass(result.text);
    removed += next.removed;
    if (next.text === result.text) return { text: next.text, removed };
    result = next;
  }
  return { text: result.text.replace(/[<>]/g, ""), removed };
}

export function cutText(text: string, limit: number): string {
  return text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "");
}
