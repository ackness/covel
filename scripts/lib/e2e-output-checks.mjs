/**
 * Checks on what the models did during an e2e run, read from trace events.
 *
 * The harness judged a run by what was committed: runtime statuses and the
 * tool calls stored on turn results. Two things were invisible there. A tool
 * call that was rejected and sent again leaves no stored record, so a run with
 * a dozen rejected calls reported "fail=0". And nothing looked at the language
 * of what the models wrote, so a run where a third of the extracted facts were
 * in the wrong language passed.
 */

const CJK = /[㐀-䶿一-鿿぀-ヿ가-힯]/g;
const LATIN_WORD = /[A-Za-z]{2,}/g;

/** Field names whose values are identifiers, enum members or paths. */
const IDENTIFIER_PATH =
  /(^|\.)(id|ids|path|topic|type|kind|key|from|to|status|category|code|slot|unit|icon|color|name)(\[\])?$/i;
/** A slot of a locale map, such as `.en-US`. */
const LOCALE_SLOT = /\.[a-z]{2}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/;

function* stringLeaves(value, path = "") {
  if (typeof value === "string") yield [path, value];
  else if (Array.isArray(value))
    for (const item of value) yield* stringLeaves(item, `${path}[]`);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value))
      yield* stringLeaves(item, path ? `${path}.${key}` : key);
}

/**
 * Tool calls that were rejected, grouped by runtime, tool and error.
 *
 * @param {readonly { type: string, payload: Record<string, unknown> }[]} events
 * @returns {{ runtimeId: string, toolName: string, error: string, count: number }[]}
 */
export function rejectedToolCalls(events) {
  const groups = new Map();
  for (const event of events) {
    if (event.type !== "tool.failed") continue;
    const { runtimeId, toolName, error } = event.payload;
    const row = {
      runtimeId: String(runtimeId ?? "?"),
      toolName: String(toolName ?? "?"),
      // Rejections of the same kind differ only in the offending value.
      error: String(error ?? "unknown").slice(0, 120),
    };
    const key = `${row.runtimeId}\u0000${row.toolName}\u0000${row.error.slice(0, 60)}`;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { ...row, count: 1 });
  }
  return [...groups.values()].sort(
    (a, b) => b.count - a.count || a.runtimeId.localeCompare(b.runtimeId),
  );
}

/** Whether a session of this locale is written in Chinese, Japanese or Korean. */
function expectsCjk(locale) {
  return /^(zh|ja|ko)([-_]|$)/i.test(locale ?? "");
}

/**
 * How much of what each runtime wrote is in the wrong script for the session.
 *
 * Reads the reply text and every string argument of every tool call. Leaves
 * out identifiers, locale-map slots and trace notes, which are English by
 * design. A value counts as prose when it has at least four CJK characters or
 * four Latin words.
 *
 * @param {readonly { type: string, payload: Record<string, unknown> }[]} events
 * @param {string} locale
 * @returns {{ runtimeId: string, prose: number, wrong: number, examples: string[] }[]}
 */
export function outputLanguageReport(events, locale) {
  const cjkSession = expectsCjk(locale);
  const rows = new Map();
  for (const event of events) {
    if (event.type !== "llm.responded") continue;
    const payload = event.payload;
    const runtimeId = String(payload.runtimeId ?? "?");
    const items = [["text", String(payload.text ?? "")]];
    for (const call of Array.isArray(payload.toolCalls)
      ? payload.toolCalls
      : []) {
      if (!call || call.name === "runtime-done") continue;
      let args;
      try {
        args = JSON.parse(call.arguments ?? "{}");
      } catch {
        continue; // Unparseable arguments are reported as a rejected call.
      }
      for (const [path, value] of stringLeaves(args))
        items.push([`${call.name}:${path}`, value]);
    }
    const row = rows.get(runtimeId) ?? {
      runtimeId,
      prose: 0,
      wrong: 0,
      examples: [],
    };
    rows.set(runtimeId, row);
    for (const [where, text] of items) {
      if (IDENTIFIER_PATH.test(where) || LOCALE_SLOT.test(where)) continue;
      const cjk = text.match(CJK)?.length ?? 0;
      const latinWords = text.match(LATIN_WORD)?.length ?? 0;
      const cjkProse = cjk >= 4;
      const latinProse = cjk < 2 && latinWords >= 4 && /\s/.test(text.trim());
      if (!cjkProse && !latinProse) continue;
      row.prose += 1;
      if (cjkSession ? latinProse : cjkProse) {
        row.wrong += 1;
        if (row.examples.length < 2)
          row.examples.push(`${where} = ${JSON.stringify(text.slice(0, 70))}`);
      }
    }
  }
  return [...rows.values()]
    .filter((row) => row.prose > 0)
    .sort((a, b) => a.runtimeId.localeCompare(b.runtimeId));
}

/**
 * A runtime fails the language check when the wrong-language share is beyond
 * what one stray value explains: at least five values and a tenth of its
 * prose. Fewer wrong values are a warning.
 *
 * @param {{ prose: number, wrong: number }} row
 * @returns {"ok" | "warn" | "fail"}
 */
export function languageVerdict(row) {
  if (row.wrong === 0) return "ok";
  return row.wrong >= 5 && row.wrong / row.prose >= 0.1 ? "fail" : "warn";
}

/**
 * Text in the wrong script that was sent to a model: Chinese, Japanese or
 * Korean characters in the prompts and tool definitions of a session in
 * another language. Each distinct line counts once, however many calls
 * repeat it.
 *
 * A model that reads Chinese context answers in Chinese. The output check
 * sees that answer; this check names where the Chinese came in. Nothing is
 * checked for a Chinese, Japanese or Korean session: English identifiers and
 * tool definitions are expected there.
 *
 * @param {readonly { type: string, payload: Record<string, unknown> }[]} events
 * @param {string} locale
 * @returns {{ runtimeId: string, characters: number, lines: number, example: string }[]}
 */
export function promptLanguageReport(events, locale) {
  if (expectsCjk(locale)) return [];
  const rows = new Map();
  const seen = new Set();
  for (const event of events) {
    if (event.type !== "llm.calling" || event.payload.concealed) continue;
    const runtimeId = String(event.payload.runtimeId ?? "?");
    const texts = [];
    for (const message of Array.isArray(event.payload.messages)
      ? event.payload.messages
      : [])
      texts.push(
        typeof message?.content === "string"
          ? message.content
          : JSON.stringify(message?.content ?? ""),
      );
    for (const tool of Array.isArray(event.payload.tools)
      ? event.payload.tools
      : [])
      texts.push(JSON.stringify(tool));
    for (const text of texts)
      for (const line of text.split("\n")) {
        const characters = line.match(CJK)?.length ?? 0;
        if (characters === 0) continue;
        const key = `${runtimeId}\u0000${line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const row = rows.get(runtimeId) ?? {
          runtimeId,
          characters: 0,
          lines: 0,
          example: line.trim().slice(0, 90),
        };
        rows.set(runtimeId, row);
        row.characters += characters;
        row.lines += 1;
      }
  }
  return [...rows.values()].sort(
    (a, b) =>
      b.characters - a.characters || a.runtimeId.localeCompare(b.runtimeId),
  );
}
