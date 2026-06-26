/**
 * Deterministic, conservative sanitisation rules for story-guard.
 *
 * Two independent concerns live here so they stay pure and unit-testable
 * without ever touching the store, proposals, or the event bus:
 *
 *   1. Red-line redaction   — replace immersion-breaking / template-leak
 *                             phrases (and deployment-configured banned terms)
 *                             with empty string or a redaction marker.
 *   2. Choice-menu stripping — drop whole lines that are obviously an enumerated
 *                             option menu or a menu header.
 *
 * Everything is regex-driven and side-effect free, so the same input always
 * yields the same output. The patterns are intentionally *conservative*:
 * they anchor to whole lines or require boilerplate anchors ("model" / "模型"
 * / a trailing colon) so they do not maul ordinary narrative prose.
 *
 * Deployment knobs are read from the environment (hooks cannot reach the
 * SettingsStore), lazily, so a host can change them without a restart and
 * tests can override them per-case:
 *
 *   STORY_GUARD_REDACT_TERMS   comma-separated literal terms → marker
 *   STORY_GUARD_REDACT_MARK    replacement marker (default "[redacted]")
 *   STORY_GUARD_BLOCKED_TOOLS  comma-separated extra tool names to block
 */

// ── Red-line redaction ───────────────────────────────────────────

/**
 * Built-in red-line rules. Each rule replaces every match of a global regex.
 * Replacement `""` deletes the phrase (the trailing-separator capture keeps the
 * sentence from being left with a dangling comma / space).
 *
 * @type {ReadonlyArray<{ pattern: RegExp, replacement: string }>}
 */
export const redactRules = Object.freeze([
  // Immersion: AI / model self-identification boilerplate (EN). Requires the
  // literal word "model" so ordinary uses of "AI" in prose are left alone.
  {
    pattern:
      /\bas an? (?:AI|artificial intelligence)(?: language)? model\b[,:]?[ \t]*/gi,
    replacement: "",
  },
  // Immersion: AI / model self-identification boilerplate (ZH). Requires a
  // model/assistant suffix (or the full "语言模型" phrase) so "作为AI伙伴" and
  // similar in-world wording are not touched.
  {
    pattern:
      /作为(?:一个|一名)?(?:(?:大型)?语言模型|(?:AI|人工智能)(?:模型|助手|程序|系统))[，,：:、]?[ \t]*/g,
    replacement: "",
  },
  // Prompt-template artifacts that must never reach narrative output.
  {
    pattern: /[ \t]*(?:\[\/?INST\]|<<\/?SYS>>)[ \t]*/g,
    replacement: "",
  },
]);

/**
 * Escape a literal string for safe embedding inside a RegExp.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redaction marker used for deployment-configured banned terms.
 *
 * @returns {string}
 */
function redactMark() {
  const mark = process.env.STORY_GUARD_REDACT_MARK;
  return typeof mark === "string" && mark.length > 0 ? mark : "[redacted]";
}

/**
 * Deployment-configured red-line rules built from `STORY_GUARD_REDACT_TERMS`.
 * Each comma-separated term is matched case-insensitively and replaced with the
 * marker. Read lazily so hosts / tests can change it without a restart.
 *
 * @returns {Array<{ pattern: RegExp, replacement: string }>}
 */
export function envRedactRules() {
  const raw = process.env.STORY_GUARD_REDACT_TERMS;
  if (!raw) return [];
  const mark = redactMark();
  return raw
    .split(",")
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .map((term) => ({
      pattern: new RegExp(escapeRegExp(term), "gi"),
      replacement: mark,
    }));
}

// ── Choice-menu stripping ────────────────────────────────────────

/**
 * Enumerated option line: a line that *starts* with an option marker followed
 * by content. ASCII markers (`A.` / `A)` / `1.` / `1)`) require a following
 * space so decimals like "1.5 apples" are never mistaken for an option. CJK
 * (`B、`) and parenthesised (`(C)` / `（3）`) markers allow no space.
 */
const OPTION_LINE =
  /^[ \t]*(?:[A-Za-z1-9][.)][ \t]+\S|[A-Za-z1-9]、[ \t]*\S|[（(][ \t]*[A-Za-z1-9][ \t]*[)）][ \t]*\S)/;

/**
 * Menu header line: a whole line that is *only* an explicit choice prompt and
 * ends with a colon. Requiring the trailing colon keeps free-form narrative
 * questions ("你想做什么？" / "What do you do?") out of scope.
 */
const CHOICE_PROMPT =
  /^[ \t]*(?:你的选择(?:是)?|你的选项|请(?:做出)?(?:你的)?选择|(?:可选项|选项)(?:如下)?|available\s+options|your\s+(?:choice|options?)|options?|please\s+choose|choose\s+one)[ \t]*[:：][ \t]*$/i;

/**
 * Remove option-menu lines and menu headers from a block of narrative text.
 * Returns the original reference unchanged when nothing matched, so a no-op
 * stays byte-identical (line endings are not normalised on the no-op path).
 *
 * @param {string} text
 * @returns {string}
 */
export function stripMenuLines(text) {
  if (typeof text !== "string" || text === "") return text;
  const lines = text.split(/\r?\n/);
  const isOption = lines.map((line) => OPTION_LINE.test(line));
  const isPrompt = lines.map((line) => CHOICE_PROMPT.test(line));
  // An option line is stripped only when it sits in a run of >= 2 consecutive
  // option lines (a real menu). A lone "I. went home." / "C. S. Lewis wrote…"
  // is ordinary prose — a sentence that happens to start with a letter + dot —
  // and is left untouched, so the guard never mauls narrative. Explicit menu
  // headers (trailing colon) are unambiguous and are always stripped on their
  // own.
  const kept = lines.filter((_line, i) => {
    if (isPrompt[i]) return false;
    if (
      isOption[i] &&
      ((i > 0 && isOption[i - 1]) || isOption[i + 1] === true)
    ) {
      return false;
    }
    return true;
  });
  if (kept.length === lines.length) return text;
  return kept.join("\n");
}

// ── Orchestrator ─────────────────────────────────────────────────

/**
 * Run the full deterministic pipeline: built-in red-line rules, then
 * env-configured banned terms, then choice-menu stripping. Pure: returns the
 * input unchanged when nothing matched.
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitize(text) {
  if (typeof text !== "string" || text === "") return text;
  let out = text;
  for (const rule of redactRules) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  for (const rule of envRedactRules()) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  out = stripMenuLines(out);
  return out;
}

// ── High-risk tool deny-list (PreToolUse) ────────────────────────

/**
 * Conservative built-in deny-list of unambiguously destructive tool names.
 * These do not collide with ordinary gameplay tools; hosts extend the list via
 * `STORY_GUARD_BLOCKED_TOOLS`.
 *
 * @type {ReadonlyArray<string>}
 */
const DEFAULT_BLOCKED_TOOLS = Object.freeze([
  "delete-everything",
  "delete-all",
  "drop-database",
  "wipe-database",
  "factory-reset",
]);

/**
 * Effective blocked-tool set: defaults ∪ `STORY_GUARD_BLOCKED_TOOLS`. Names are
 * lower-cased for case-insensitive comparison. Read lazily.
 *
 * @returns {Set<string>}
 */
export function blockedTools() {
  const set = new Set(DEFAULT_BLOCKED_TOOLS);
  const raw = process.env.STORY_GUARD_BLOCKED_TOOLS;
  if (raw) {
    for (const name of raw.split(",")) {
      const trimmed = name.trim().toLowerCase();
      if (trimmed) set.add(trimmed);
    }
  }
  return set;
}

/**
 * Whether a given tool name is on the deny-list (case-insensitive).
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isBlockedTool(name) {
  if (typeof name !== "string" || name === "") return false;
  return blockedTools().has(name.trim().toLowerCase());
}
