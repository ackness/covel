import { isLocaleMap, resolveI18nText } from "@covel/plugin-handlers-utils";
import {
  compareCondition,
  conditionOperatorOf,
  NUMERIC_CONDITION_OPERATORS,
  readConditionPath,
} from "@covel/plugin-handlers-utils/conditions";

// Hybrid four-valued condition evaluation for hidden story triggers:
// - "true" / "false": decided deterministically (or from a cached judge verdict)
// - "undecided": unavailable reference or malformed leaf (never flips under `not`)
// - "pending": needs the concealed semantic judge sub-agent (only if not short-circuited)

/** Bounds of a turn condition: the first and the last session turn it holds on. */
export const TURN_BOUNDS = ["turnGte", "turnLte"];

const NUMERIC_OPS = new Set(NUMERIC_CONDITION_OPERATORS);

const RESERVED_CONDITION_KEYS = new Set([
  "all",
  "any",
  "not",
  "judge",
  "id",
  "scope",
  "sticky",
  "watch",
  "dimension",
  "path",
  "time",
  "affinity",
  "item",
  "attribute",
  "revealed",
  "selected",
  "turnsSinceGte",
  "turnsSinceLte",
  "turnGte",
  "turnLte",
  "equals",
  "notEquals",
  "in",
  "gte",
  "gt",
  "lte",
  "lt",
  "exists",
]);

function isShorthandJudgeTextMap(value) {
  if (!isLocaleMap(value)) return false;
  const entries = Object.entries(value);
  return entries.every(
    ([key, item]) =>
      !RESERVED_CONDITION_KEYS.has(key) && item.trim().length > 0,
  );
}

function asStatus(bool) {
  return bool ? "true" : "false";
}

function chainLeaf(node, idKey, recordMap, validIds, state, issues, label) {
  const targetId = node[idKey];
  if (validIds && !validIds.has(targetId)) {
    issues.push(`unknown ${label}: ${targetId}`);
    return "undecided";
  }
  const record = recordMap?.[targetId];
  if (!record) return "false";
  const since = (state.turn ?? 0) - (record.lastTurn ?? 0);
  if (Number.isInteger(node.turnsSinceGte) && since < node.turnsSinceGte)
    return "false";
  if (Number.isInteger(node.turnsSinceLte) && since > node.turnsSinceLte)
    return "false";
  return "true";
}

function turnLeaf(node, state, issues) {
  if (!Number.isInteger(state.turn)) {
    issues.push("the session turn is unavailable");
    return "undecided";
  }
  if (Number.isInteger(node.turnGte) && state.turn < node.turnGte)
    return "false";
  if (Number.isInteger(node.turnLte) && state.turn > node.turnLte)
    return "false";
  return "true";
}

function affinityLeaf(node, operator, state, issues) {
  if (!state.affinity) {
    issues.push("affinity is unavailable");
    return "undecided";
  }
  const key = node.affinity.trim().toLowerCase();
  const entry = state.affinity.get(key);
  if (operator === "exists" && node.path === undefined)
    return asStatus(compareCondition("exists", entry, node.exists));
  if (!entry) {
    issues.push(`unknown affinity character: ${node.affinity}`);
    return "undecided";
  }
  const field =
    node.path !== undefined
      ? node.path
      : NUMERIC_OPS.has(operator) || typeof node[operator] === "number"
        ? "score"
        : "tier";
  return asStatus(
    compareCondition(operator, readConditionPath(entry, field), node[operator]),
  );
}

function itemLeaf(node, operator, state, issues) {
  if (!state.items) {
    issues.push("inventory is unavailable");
    return "undecided";
  }
  const key = node.item.trim().toLowerCase();
  const raw = state.items.get(key);
  const entry = raw && Number(raw.quantity ?? 1) > 0 ? raw : undefined;
  if (operator === "exists" && node.path === undefined)
    return asStatus(compareCondition("exists", entry, node.exists));
  const field =
    node.path !== undefined
      ? node.path
      : NUMERIC_OPS.has(operator) || typeof node[operator] === "number"
        ? "quantity"
        : undefined;
  if (!entry) {
    const actual = field === "quantity" ? 0 : undefined;
    return asStatus(compareCondition(operator, actual, node[operator]));
  }
  const actual = field === undefined ? entry : readConditionPath(entry, field);
  return asStatus(compareCondition(operator, actual, node[operator]));
}

function attributeLeaf(node, operator, state, issues) {
  if (!state.playerFields) {
    issues.push("player character is unavailable");
    return "undecided";
  }
  const base = state.playerFields[node.attribute];
  const actual =
    node.path === undefined ? base : readConditionPath(base, node.path);
  return asStatus(compareCondition(operator, actual, node[operator]));
}

function judgeLeaf(node, pathKey, state, options, issues, pending) {
  const question = resolveI18nText(node.judge, state.locale)?.trim();
  if (!question) {
    issues.push("judge condition must be non-empty text");
    return "undecided";
  }
  const leafId =
    typeof node.id === "string" && node.id.trim() ? node.id.trim() : pathKey;
  const key = `${options.scopeId ?? "root"}#${leafId}`;
  const sticky = node.sticky !== false;
  const scope = node.scope ?? "narrative";

  const cached = state.judgments?.[key];
  if (cached) {
    if (sticky && cached.met === true) return "true";
    const sameTurn =
      (state.sourceTurnId && cached.sourceTurnId === state.sourceTurnId) ||
      (state.turnId && cached.turnId === state.turnId);
    const samePhase =
      !options.phase || !cached.phase || cached.phase === options.phase;
    if (sameTurn && (cached.met === true || samePhase)) {
      return asStatus(cached.met === true);
    }
  }

  if (options.semanticEnabled === false) return "undecided";
  if (options.deferSemantic === true) return "undecided";

  pending.push({
    key,
    question,
    scope,
    sticky,
    watch: node.watch ?? null,
    cached: cached ?? null,
  });
  return "pending";
}

/**
 * Inspect a condition tree under four-valued logic (`true`, `false`,
 * `undecided`, `pending`). Short-circuits `all` on `false`/`undecided` and
 * `any` on `true` so semantic `judge` leaves in pruned branches never trigger
 * an LLM call.
 */
export function inspectCondition(condition, state, options = {}) {
  const issues = [];
  const undecided = (issue) => {
    issues.push(issue);
    return { status: "undecided", pending: [] };
  };

  const visit = (node, pathKey) => {
    if (typeof node === "string") {
      const pending = [];
      const status = judgeLeaf(
        { judge: node },
        pathKey,
        state,
        options,
        issues,
        pending,
      );
      return { status, pending };
    }
    if (!node || typeof node !== "object" || Array.isArray(node))
      return undecided("condition must be an object");

    if (Array.isArray(node.all)) {
      const results = node.all.map((child, idx) =>
        visit(child, `${pathKey}.${idx}`),
      );
      if (results.some((r) => r.status === "false"))
        return { status: "false", pending: [] };
      if (results.some((r) => r.status === "undecided"))
        return { status: "undecided", pending: [] };
      const pending = results.flatMap((r) => r.pending);
      if (pending.length > 0 || results.some((r) => r.status === "pending"))
        return { status: "pending", pending };
      return { status: "true", pending: [] };
    }

    if (Array.isArray(node.any)) {
      const results = node.any.map((child, idx) =>
        visit(child, `${pathKey}.${idx}`),
      );
      if (results.some((r) => r.status === "true"))
        return { status: "true", pending: [] };
      const pending = results.flatMap((r) => r.pending);
      if (pending.length > 0 || results.some((r) => r.status === "pending"))
        return { status: "pending", pending };
      if (results.some((r) => r.status === "undecided"))
        return { status: "undecided", pending: [] };
      return { status: "false", pending: [] };
    }

    if (Object.hasOwn(node, "not")) {
      const child = visit(node.not, `${pathKey}.not`);
      if (child.status === "true") return { status: "false", pending: [] };
      if (child.status === "false") return { status: "true", pending: [] };
      return child;
    }

    if (Object.hasOwn(node, "judge")) {
      const pending = [];
      const status = judgeLeaf(node, pathKey, state, options, issues, pending);
      return { status, pending };
    }

    if (typeof node.revealed === "string") {
      return {
        status: chainLeaf(
          node,
          "revealed",
          state.revealed,
          state.eventIds,
          state,
          issues,
          "event",
        ),
        pending: [],
      };
    }

    if (typeof node.selected === "string") {
      return {
        status: chainLeaf(
          node,
          "selected",
          state.selectedOptions,
          state.optionIds,
          state,
          issues,
          "option",
        ),
        pending: [],
      };
    }

    if (TURN_BOUNDS.some((key) => Object.hasOwn(node, key)))
      return { status: turnLeaf(node, state, issues), pending: [] };

    const operator = conditionOperatorOf(node);
    if (!operator) {
      // Allow an i18n locale map at root/branch as a shorthand judge condition
      // only if it is a strict locale map without condition keywords.
      if (isShorthandJudgeTextMap(node)) {
        const pending = [];
        const status = judgeLeaf(
          { judge: node },
          pathKey,
          state,
          options,
          issues,
          pending,
        );
        return { status, pending };
      }
      return undecided("a condition leaf needs exactly one operator");
    }

    if (typeof node.dimension === "string") {
      const entry = state.dimensions?.[node.dimension];
      if (!entry) return undecided(`unknown dimension: ${node.dimension}`);
      return {
        status: asStatus(
          compareCondition(
            operator,
            readConditionPath(entry.value, node.path),
            node[operator],
          ),
        ),
        pending: [],
      };
    }

    if (typeof node.time === "string") {
      if (!state.time) return undecided("world time is unavailable");
      return {
        status: asStatus(
          compareCondition(operator, state.time[node.time], node[operator]),
        ),
        pending: [],
      };
    }

    if (typeof node.affinity === "string")
      return {
        status: affinityLeaf(node, operator, state, issues),
        pending: [],
      };

    if (typeof node.item === "string")
      return { status: itemLeaf(node, operator, state, issues), pending: [] };

    if (typeof node.attribute === "string")
      return {
        status: attributeLeaf(node, operator, state, issues),
        pending: [],
      };

    return undecided(
      "a condition leaf must reference a dimension, time, affinity, item, attribute, event, option, judge, or the turn",
    );
  };

  const result = visit(condition, "0");
  return { status: result.status, pending: result.pending, issues };
}

/**
 * Boolean evaluator over a condition tree.
 * Trees that end `undecided` or `pending` evaluate to `met: false`.
 */
export function evaluateCondition(condition, state, options = {}) {
  const { status, issues } = inspectCondition(condition, state, options);
  return { met: status === "true", issues };
}

/** Whether a condition tree contains at least one semantic `judge` leaf. */
export function hasJudgeLeaf(condition) {
  if (typeof condition === "string") return condition.trim().length > 0;
  if (!condition || typeof condition !== "object" || Array.isArray(condition))
    return false;
  if (Array.isArray(condition.all)) return condition.all.some(hasJudgeLeaf);
  if (Array.isArray(condition.any)) return condition.any.some(hasJudgeLeaf);
  if (Object.hasOwn(condition, "not")) return hasJudgeLeaf(condition.not);
  return (
    Object.hasOwn(condition, "judge") || isShorthandJudgeTextMap(condition)
  );
}

/** Collect cross-plugin references used anywhere in a condition tree. */
export function collectConditionRefs(
  condition,
  out = {
    affinityNames: new Set(),
    usesItems: false,
    usesAttributes: false,
    usesJudge: false,
  },
) {
  if (typeof condition === "string") {
    if (condition.trim()) out.usesJudge = true;
    return out;
  }
  if (!condition || typeof condition !== "object" || Array.isArray(condition))
    return out;
  if (Array.isArray(condition.all)) {
    for (const child of condition.all) collectConditionRefs(child, out);
    return out;
  }
  if (Array.isArray(condition.any)) {
    for (const child of condition.any) collectConditionRefs(child, out);
    return out;
  }
  if (Object.hasOwn(condition, "not")) {
    collectConditionRefs(condition.not, out);
    return out;
  }
  if (Object.hasOwn(condition, "judge") || isShorthandJudgeTextMap(condition))
    out.usesJudge = true;
  if (typeof condition.affinity === "string" && condition.affinity.trim())
    out.affinityNames.add(condition.affinity.trim());
  if (typeof condition.item === "string" && condition.item.trim())
    out.usesItems = true;
  if (typeof condition.attribute === "string" && condition.attribute.trim())
    out.usesAttributes = true;
  return out;
}
