import {
  assertEntityEnvelope,
  makeProposal,
  normalizeRequiredString,
  optionalNumber,
  optionalString,
  readManualEntity,
  splitList,
} from "@covel/plugin-handlers-utils";
import { shortId, withPendingProposals } from "@covel/tools";

const RULE_NAMESPACE = "rules";
const RULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const VALID_KINDS = new Set(["constant", "triggered", "evolving"]);
const VALID_CATEGORIES = new Set([
  "character",
  "scene",
  "relationship",
  "world",
  "style",
]);
const VALID_POSITIONS = new Set(["before_plugin", "after_plugin", "at_depth"]);
const VALID_BUDGET_CLASSES = new Set(["sticky", "flexible", "droppable"]);

/**
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export default async function handler(ctx) {
  const payload = ctx.manualPayload ?? {};
  const rule = normalizeRule(
    readManualEntity(payload, "rule", (form) =>
      ruleFromForm(form, payload.enabled !== false, ctx.sessionId),
    ),
  );
  const now = new Date().toISOString();
  const lorebookEntryId = lorebookIdForRule(rule.id);

  const proposals = [
    makeProposal(ctx, now, "plugin.data", {
      namespace: RULE_NAMESPACE,
      key: rule.id,
      // Store the rule fields flat (title/content/kind at the top of `value`)
      // so this matches the world-data import shape — the panel reads
      // value/title etc. Both writers must agree; the import path stores flat.
      value: {
        ...rule,
        lorebookEntryId,
        updatedAt: now,
      },
    }),
    makeProposal(ctx, now, "lorebook.upsert", {
      entries: [ruleToLorebookEntry(rule, lorebookEntryId)],
    }),
  ];

  return withPendingProposals(
    {
      outcome: "success",
      value: {
        saved: true,
        ruleId: rule.id,
        lorebookEntryId,
      },
    },
    proposals,
  );
}

/**
 * @param {Record<string, unknown>} form
 * @param {boolean} enabled
 * @param {string} sessionId
 */
function ruleFromForm(form, enabled, sessionId) {
  const position = optionalString(form.position);
  const depth = optionalNumber(form.depth);
  const title = optionalString(form.title);
  const content = normalizeRequiredString(form.content, "rule.content");
  return {
    schemaVersion: 1,
    id: optionalString(form.id) ?? shortId("rule", title ?? content, sessionId),
    ...(title ? { title } : {}),
    content,
    kind: optionalString(form.kind) ?? "constant",
    ...(optionalString(form.category)
      ? { category: optionalString(form.category) }
      : {}),
    enabled,
    coordinate: {
      position: position ?? "after_plugin",
      ...(depth !== undefined ? { depth } : {}),
    },
    ...(optionalString(form.budgetClass)
      ? { budgetClass: optionalString(form.budgetClass) }
      : {}),
    ...(splitList(form.keysText).length > 0
      ? { keys: splitList(form.keysText) }
      : {}),
    ...(optionalNumber(form.insertionOrder) !== undefined
      ? { insertionOrder: optionalNumber(form.insertionOrder) }
      : {}),
  };
}

/**
 * @param {unknown} value
 */
function normalizeRule(value) {
  return assertEntityEnvelope(value, {
    entity: "rule",
    idPattern: RULE_ID_PATTERN,
    idError:
      "rule.id must be 1-128 characters using letters, digits, underscore, or hyphen",
    build: (base) => {
      const category = normalizeOptionalEnum(
        base.category,
        VALID_CATEGORIES,
        "rule.category",
      );
      const budgetClass = normalizeOptionalEnum(
        base.budgetClass,
        VALID_BUDGET_CLASSES,
        "rule.budgetClass",
      );
      const keys = splitList(base.keys);
      const insertionOrder = normalizeOptionalNumber(
        base.insertionOrder,
        "rule.insertionOrder",
      );
      return {
        ...base,
        content: normalizeRequiredString(base.content, "rule.content"),
        kind: normalizeKind(base.kind),
        enabled: base.enabled !== false,
        coordinate: normalizeCoordinate(base.coordinate),
        ...(category ? { category } : {}),
        ...(budgetClass ? { budgetClass } : {}),
        ...(keys.length > 0 ? { keys } : {}),
        ...(insertionOrder !== undefined ? { insertionOrder } : {}),
      };
    },
  });
}

function normalizeKind(value) {
  if (value === undefined) return "constant";
  if (typeof value !== "string" || !VALID_KINDS.has(value)) {
    throw new Error("rule.kind must be constant, triggered, or evolving");
  }
  return value;
}

function normalizeCoordinate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { position: "after_plugin" };
  }
  const input = /** @type {Record<string, unknown>} */ (value);
  const position =
    typeof input.position === "string" ? input.position : "after_plugin";
  if (!VALID_POSITIONS.has(position)) {
    throw new Error(
      "rule.coordinate.position must be before_plugin, after_plugin, or at_depth",
    );
  }
  const depth = normalizeOptionalNumber(input.depth, "rule.coordinate.depth");
  return {
    position,
    ...(depth !== undefined ? { depth: Math.max(0, Math.round(depth)) } : {}),
  };
}

function normalizeOptionalEnum(value, allowed, field) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function normalizeOptionalNumber(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function lorebookIdForRule(ruleId) {
  return `lwr-${ruleId}`;
}

function ruleToLorebookEntry(rule, lorebookEntryId) {
  const coordinate = rule.coordinate ?? { position: "after_plugin" };
  // Only KEYWORD-gated `triggered` rules become `selective` (the framework
  // drops a selective lorebook entry whose keys are empty). `evolving` and
  // `constant` are always-on; a `triggered` rule saved WITHOUT keywords would
  // otherwise persist as enabled yet never reach the prompt — a silent drop —
  // so it falls back to always-on `constant` instead.
  const keys = Array.isArray(rule.keys) ? rule.keys : [];
  const strategy =
    rule.kind === "triggered" && keys.length > 0 ? "selective" : "constant";
  return {
    id: lorebookEntryId,
    content: rule.content,
    strategy,
    position: coordinate.position,
    insertionOrder:
      typeof rule.insertionOrder === "number" ? rule.insertionOrder : 500,
    enabled: rule.enabled !== false,
    keys,
    extra: {
      kind: rule.kind ?? "constant",
      ...(rule.title ? { title: rule.title } : {}),
      ...(rule.category ? { category: rule.category } : {}),
      coordinate,
      ...(rule.budgetClass ? { budgetClass: rule.budgetClass } : {}),
      ...(rule.owner ? { owner: rule.owner } : {}),
      sourceRuleId: rule.id,
    },
  };
}
