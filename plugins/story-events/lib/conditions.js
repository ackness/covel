// Deterministic condition evaluation for hidden story events. No model calls:
// every leaf reads a frozen dimension value or the current world-time value.

export const OPERATORS = [
  "equals",
  "notEquals",
  "in",
  "gte",
  "gt",
  "lte",
  "lt",
  "exists",
];

function jsonEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.keys(left);
  const b = Object.keys(right);
  return (
    a.length === b.length &&
    a.every(
      (key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]),
    )
  );
}

function readPath(value, path) {
  const segments = Array.isArray(path)
    ? path
    : typeof path === "string" && path.length
      ? path.split(".")
      : [];
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    current = Array.isArray(current)
      ? current[Number(segment)]
      : current[segment];
  }
  return current;
}

function compare(operator, actual, expected) {
  switch (operator) {
    case "exists":
      return (actual !== undefined && actual !== null) === (expected !== false);
    case "equals":
      return jsonEqual(actual, expected);
    case "notEquals":
      return !jsonEqual(actual, expected);
    case "in":
      return (
        Array.isArray(expected) &&
        expected.some((item) => jsonEqual(actual, item))
      );
    case "gte":
      return typeof actual === "number" && actual >= expected;
    case "gt":
      return typeof actual === "number" && actual > expected;
    case "lte":
      return typeof actual === "number" && actual <= expected;
    case "lt":
      return typeof actual === "number" && actual < expected;
    default:
      return false;
  }
}

function leafOperator(condition) {
  const found = OPERATORS.filter((operator) =>
    Object.hasOwn(condition, operator),
  );
  return found.length === 1 ? found[0] : null;
}

/**
 * A node evaluates to `true`, `false`, or `null` when it cannot be judged:
 * it refers to something that does not exist here, or it is malformed.
 */

/**
 * `{ revealed: id }` holds once that event has fired; `turnsSinceGte` /
 * `turnsSinceLte` bound the turns elapsed since it last fired. An event that
 * exists and has not fired is a plain `false`.
 */
function revealedLeaf(node, state, issues) {
  if (state.eventIds && !state.eventIds.has(node.revealed)) {
    issues.push(`unknown event: ${node.revealed}`);
    return null;
  }
  const record = state.revealed?.[node.revealed];
  if (!record) return false;
  const since = (state.turn ?? 0) - (record.lastTurn ?? 0);
  if (Number.isInteger(node.turnsSinceGte) && since < node.turnsSinceGte)
    return false;
  if (Number.isInteger(node.turnsSinceLte) && since > node.turnsSinceLte)
    return false;
  return true;
}

/**
 * Evaluate a condition tree against `{ dimensions, time, revealed, turn }`.
 * `dimensions` maps dimension IDs to snapshot entries (`{ value, version }`);
 * `time` is the world-time context value, or null when world time is absent;
 * `revealed` maps event IDs to their reveal records for chained events.
 *
 * A leaf that cannot be judged is reported in `issues` and stays undecided
 * through `not`, so "not (something unavailable)" never holds. `any` still
 * holds through another branch and `all` still fails on a false one; a tree
 * that ends undecided is not met.
 */
export function evaluateCondition(condition, state) {
  const issues = [];
  const undecided = (issue) => {
    issues.push(issue);
    return null;
  };
  const visit = (node) => {
    if (!node || typeof node !== "object" || Array.isArray(node))
      return undecided("condition must be an object");
    if (Array.isArray(node.all)) {
      const results = node.all.map(visit);
      if (results.includes(false)) return false;
      return results.includes(null) ? null : true;
    }
    if (Array.isArray(node.any)) {
      const results = node.any.map(visit);
      if (results.includes(true)) return true;
      return results.includes(null) ? null : false;
    }
    if (Object.hasOwn(node, "not")) {
      const result = visit(node.not);
      return result === null ? null : !result;
    }
    if (typeof node.revealed === "string")
      return revealedLeaf(node, state, issues);
    const operator = leafOperator(node);
    if (!operator)
      return undecided("a condition leaf needs exactly one operator");
    if (typeof node.dimension === "string") {
      const entry = state.dimensions?.[node.dimension];
      if (!entry) return undecided(`unknown dimension: ${node.dimension}`);
      return compare(
        operator,
        readPath(entry.value, node.path),
        node[operator],
      );
    }
    if (typeof node.time === "string") {
      if (!state.time) return undecided("world time is unavailable");
      return compare(operator, state.time[node.time], node[operator]);
    }
    return undecided("a condition leaf must reference a dimension or time");
  };
  const met = visit(condition) === true;
  return { met, issues };
}

/** A locale tag in canonical form: `en_us` and `en-us` are both `en-US`. */
function canonicalTag(tag) {
  try {
    return new Intl.Locale(String(tag).replace(/_/g, "-")).toString();
  } catch {
    return undefined;
  }
}

/** Language and script of a locale tag, with the likely script filled in. */
function languageAndScript(tag) {
  try {
    const { language, script } = new Intl.Locale(tag).maximize();
    return `${language}-${script}`;
  } catch {
    return undefined;
  }
}

/**
 * The text for `tag`: its own key, then the language-only key when that is the
 * same script (`en` for `en-GB`, never `zh` for `zh-Hant-HK`), then any key in
 * the same language and script.
 */
function textFor(texts, tag) {
  const wanted = canonicalTag(tag);
  if (!wanted) return undefined;
  const keyed = (candidate) =>
    texts.find(([key]) => canonicalTag(key) === candidate)?.[1];
  const exact = keyed(wanted);
  if (exact !== undefined) return exact;
  const script = languageAndScript(wanted);
  const { language } = new Intl.Locale(wanted);
  if (languageAndScript(language) === script) {
    const generic = keyed(language);
    if (generic !== undefined) return generic;
  }
  return texts.find(
    ([key]) => languageAndScript(canonicalTag(key) ?? "") === script,
  )?.[1];
}

/**
 * Pick the localized text for a plain string or `{ "zh-CN": …, "en-US": … }`
 * map: the session's locale, then English as `en-US` reads it (`en-US`, then
 * `en`, then another English text), then any text.
 */
export function localizedText(value, locale) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const texts = Object.entries(value).filter(
    ([, text]) => typeof text === "string",
  );
  return (
    (locale ? textFor(texts, locale) : undefined) ??
    textFor(texts, "en-US") ??
    texts[0]?.[1] ??
    ""
  );
}
