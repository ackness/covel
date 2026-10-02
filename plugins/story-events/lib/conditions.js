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
 * `{ revealed: id }` holds once that event has fired; `turnsSinceGte` /
 * `turnsSinceLte` bound the turns elapsed since it last fired.
 */
function revealedLeaf(node, state, issues) {
  if (state.eventIds && !state.eventIds.has(node.revealed)) {
    issues.push(`unknown event: ${node.revealed}`);
    return false;
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
 * Unknown references never match and are reported in `issues`.
 */
export function evaluateCondition(condition, state) {
  const issues = [];
  const visit = (node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      issues.push("condition must be an object");
      return false;
    }
    if (Array.isArray(node.all)) return node.all.map(visit).every(Boolean);
    if (Array.isArray(node.any)) return node.any.map(visit).some(Boolean);
    if (Object.hasOwn(node, "not")) return !visit(node.not);
    if (typeof node.revealed === "string")
      return revealedLeaf(node, state, issues);
    const operator = leafOperator(node);
    if (!operator) {
      issues.push("a condition leaf needs exactly one operator");
      return false;
    }
    if (typeof node.dimension === "string") {
      const entry = state.dimensions?.[node.dimension];
      if (!entry) {
        issues.push(`unknown dimension: ${node.dimension}`);
        return false;
      }
      return compare(
        operator,
        readPath(entry.value, node.path),
        node[operator],
      );
    }
    if (typeof node.time === "string") {
      if (!state.time) {
        issues.push("world time is unavailable");
        return false;
      }
      return compare(operator, state.time[node.time], node[operator]);
    }
    issues.push("a condition leaf must reference a dimension or time");
    return false;
  };
  const met = visit(condition);
  return { met, issues };
}

function languageOf(tag) {
  try {
    return new Intl.Locale(tag).language;
  } catch {
    return undefined;
  }
}

/** Pick the localized text for a plain string or `{ "zh-CN": …, "en-US": … }` map. */
export function localizedText(value, locale) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (locale && typeof value[locale] === "string") return value[locale];
  const language = locale ? languageOf(locale) : undefined;
  const sameLanguage = Object.keys(value).find(
    (key) => languageOf(key) === language && typeof value[key] === "string",
  );
  if (sameLanguage) return value[sameLanguage];
  return Object.values(value).find((text) => typeof text === "string") ?? "";
}
