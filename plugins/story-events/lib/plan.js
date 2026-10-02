// Validation and merge rules for hidden events planned by other runtimes
// during play. Planned events live beside the world author's events but never
// replace them, never rewrite an event that already fired, and always fire
// at most once.

import { OPERATORS } from "./conditions.js";

const EVENT_ID = /^[a-z][a-z0-9-]{0,63}$/;
const EVENT_FIELDS = new Set(["id", "title", "when", "payload", "priority"]);
const LEAF_FIELDS = new Set([
  "dimension",
  "path",
  "time",
  "revealed",
  "turnsSinceGte",
  "turnsSinceLte",
  ...OPERATORS,
]);
const NUMERIC_OPERATORS = new Set(["gte", "gt", "lte", "lt"]);
const MAX_DEPTH = 6;

/** Planned events waiting to fire, across every planner. */
export const MAX_PENDING_PLANNED = 8;
/** Events one plan may add or update. */
export const MAX_EVENTS_PER_PLAN = 3;

function isText(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const texts = Object.values(value);
  return (
    texts.length > 0 &&
    texts.every((text) => typeof text === "string" && text.trim())
  );
}

function leafIssues(node, refs, issues) {
  for (const key of Object.keys(node))
    if (!LEAF_FIELDS.has(key)) issues.push(`unknown condition field: ${key}`);
  const kinds = ["dimension", "time", "revealed"].filter((key) =>
    Object.hasOwn(node, key),
  );
  if (kinds.length !== 1) {
    issues.push(
      "a condition leaf references exactly one of dimension, time, revealed",
    );
    return;
  }
  if (kinds[0] === "revealed") {
    if (!refs.eventIds.has(node.revealed))
      issues.push(`unknown event: ${node.revealed}`);
    for (const key of ["turnsSinceGte", "turnsSinceLte"])
      if (
        Object.hasOwn(node, key) &&
        !(Number.isInteger(node[key]) && node[key] >= 0)
      )
        issues.push(`${key} must be a non-negative integer`);
    return;
  }
  const operators = OPERATORS.filter((key) => Object.hasOwn(node, key));
  if (operators.length !== 1) {
    issues.push("a condition leaf needs exactly one operator");
    return;
  }
  const [operator] = operators;
  if (NUMERIC_OPERATORS.has(operator) && typeof node[operator] !== "number")
    issues.push(`${operator} needs a number`);
  if (operator === "in" && !Array.isArray(node.in))
    issues.push("in needs an array");
  if (operator === "exists" && typeof node.exists !== "boolean")
    issues.push("exists needs a boolean");
  if (kinds[0] === "dimension") {
    if (refs.dimensions && !refs.dimensions.has(node.dimension))
      issues.push(`unknown dimension: ${node.dimension}`);
  } else if (refs.timeFields && !refs.timeFields.has(node.time)) {
    issues.push(`unknown time field: ${node.time}`);
  }
}

/**
 * Structural and reference problems in a condition tree. `refs.dimensions`
 * and `refs.timeFields` may be null when that state is unavailable, which
 * skips the matching reference check.
 */
export function conditionIssues(condition, refs) {
  const issues = [];
  const visit = (node, depth) => {
    if (depth > MAX_DEPTH) {
      issues.push("condition nests too deeply");
      return;
    }
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      issues.push("condition must be an object");
      return;
    }
    for (const group of ["all", "any"]) {
      if (!Object.hasOwn(node, group)) continue;
      if (Object.keys(node).length !== 1 || !Array.isArray(node[group]))
        issues.push(`${group} must be the only field and hold an array`);
      else if (!node[group].length) issues.push(`${group} must not be empty`);
      else for (const child of node[group]) visit(child, depth + 1);
      return;
    }
    if (Object.hasOwn(node, "not")) {
      if (Object.keys(node).length !== 1)
        issues.push("not must be the only field");
      else visit(node.not, depth + 1);
      return;
    }
    leafIssues(node, refs, issues);
  };
  visit(condition, 0);
  return [...new Set(issues)];
}

function plannedEventIssues(event, refs) {
  if (!event || typeof event !== "object" || Array.isArray(event))
    return ["event must be an object"];
  const issues = [];
  for (const key of Object.keys(event))
    if (!EVENT_FIELDS.has(key)) issues.push(`unknown event field: ${key}`);
  if (typeof event.id !== "string" || !EVENT_ID.test(event.id))
    issues.push("id must be lowercase kebab-case");
  if (!isText(event.payload)) issues.push("payload must be non-empty text");
  if (event.title !== undefined && !isText(event.title))
    issues.push("title must be non-empty text");
  if (event.priority !== undefined && !Number.isInteger(event.priority))
    issues.push("priority must be an integer");
  issues.push(...conditionIssues(event.when, refs));
  return issues;
}

/**
 * Merge plans from this execution into the planned-event bucket.
 *
 * `plans` are `{ value: { events?, retire? }, source: { pluginId, runtimeId } }`
 * items; `authored` and `planned` map event IDs to stored events; `revealed`
 * maps event IDs to reveal records. Returns the bucket writes (`value: null`
 * deletes) and a payload-free report of what was accepted or rejected.
 */
export function applyPlans({
  plans,
  authored,
  planned,
  revealed,
  dimensions,
  timeFields,
  turn,
}) {
  const next = new Map(Object.entries(planned));
  const writes = new Map();
  const accepted = [];
  const retired = [];
  const rejected = [];
  const reject = (origin, id, reason) =>
    rejected.push({ ...(id ? { id } : {}), origin, reason });

  for (const plan of plans) {
    const origin = plan.source?.runtimeId ?? "unknown";
    const value = plan.value ?? {};

    for (const id of Array.isArray(value.retire) ? value.retire : []) {
      if (!next.has(id)) reject(origin, id, "not a planned event");
      else if (revealed[id]) reject(origin, id, "already fired");
      else {
        next.delete(id);
        writes.set(id, null);
        retired.push(id);
      }
    }

    const events = Array.isArray(value.events) ? value.events : [];
    if (events.length > MAX_EVENTS_PER_PLAN) {
      reject(
        origin,
        null,
        `a plan may add at most ${MAX_EVENTS_PER_PLAN} events`,
      );
      continue;
    }
    // Events in the same plan may chain on each other.
    const refs = {
      dimensions,
      timeFields,
      eventIds: new Set([
        ...Object.keys(authored),
        ...next.keys(),
        ...events.map((event) => event?.id).filter(Boolean),
      ]),
    };
    for (const event of events) {
      const issues = plannedEventIssues(event, refs);
      const id = typeof event?.id === "string" ? event.id : null;
      if (issues.length) {
        reject(origin, id, issues.join("; "));
        continue;
      }
      if (authored[id]) {
        reject(origin, id, "the world already defines this event");
        continue;
      }
      if (revealed[id]) {
        reject(origin, id, "already fired");
        continue;
      }
      const pending = [...next.keys()].filter(
        (key) => key !== id && !revealed[key],
      ).length;
      if (pending >= MAX_PENDING_PLANNED) {
        reject(
          origin,
          id,
          `at most ${MAX_PENDING_PLANNED} planned events may wait at once`,
        );
        continue;
      }
      const stored = {
        ...event,
        once: true,
        origin: {
          pluginId: plan.source?.pluginId ?? "unknown",
          runtimeId: origin,
        },
        plannedTurn: next.get(id)?.plannedTurn ?? turn,
      };
      next.set(id, stored);
      writes.set(id, stored);
      accepted.push(id);
    }
  }

  return {
    writes: [...writes].map(([key, value]) => ({ key, value })),
    accepted,
    retired,
    rejected,
  };
}
