export function outlineNote(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `- ${line.replace(/^(?:[-*+•‣◦]|\d+[.)])\s+(?=\S)/u, "")}`)
    .join("\n");
}
