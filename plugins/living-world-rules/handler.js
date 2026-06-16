import {
  makeProposal,
  normalizeRequiredString,
  optionalNumber,
  optionalString,
  splitList,
} from "@covel/plugin-handlers-utils";
import { shortId, withPendingProposals } from "@covel/tools";

const RULE_NAMESPACE = "rules";
const MAX_RULE_BYTES = 65_536;
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
  const rule = normalizeRule(readRulePayload(payload, ctx.sessionId));
  const now = new Date().toISOString();
  const lorebookEntryId = lorebookIdForRule(rule.id);

  const proposals = [
    makeProposal(ctx, now, "plugin.data", {
      namespace: RULE_NAMESPACE,
      key: rule.id,
      value: {
        rule,
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
      saved: true,
      ruleId: rule.id,
      lorebookEntryId,
    },
    proposals,
  );
}

function readRulePayload(payload, sessionId) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    if (
      typeof payload.ruleJson === "string" &&
      payload.ruleJson.trim().length > 0
    ) {
      try {
        return JSON.parse(payload.ruleJson);
      } catch {
        throw new Error("manualPayload.ruleJson must be valid JSON");
      }
    }
    if (payload.ruleForm && typeof payload.ruleForm === "object") {
      return ruleFromForm(
        /** @type {Record<string, unknown>} */ (payload.ruleForm),
        payload.enabled !== false,
        sessionId,
      );
    }
    return payload.rule;
  }
  return undefined;
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("manualPayload.rule must be an object");
  }

  const input = /** @type {Record<string, unknown>} */ (value);
  const id = normalizeRequiredString(input.id, "rule.id");
  const content = normalizeRequiredString(input.content, "rule.content");
  if (!RULE_ID_PATTERN.test(id)) {
    throw new Error(
      "rule.id must be 1-128 characters using letters, digits, underscore, or hyphen",
    );
  }
  const schemaVersion = input.schemaVersion ?? 1;
  if (schemaVersion !== 1) {
    throw new Error("rule.schemaVersion must be 1");
  }

  const kind = normalizeKind(input.kind);
  const coordinate = normalizeCoordinate(input.coordinate);
  const category = normalizeOptionalEnum(
    input.category,
    VALID_CATEGORIES,
    "rule.category",
  );
  const budgetClass = normalizeOptionalEnum(
    input.budgetClass,
    VALID_BUDGET_CLASSES,
    "rule.budgetClass",
  );
  const keys = normalizeStringArray(input.keys);
  const insertionOrder = normalizeOptionalNumber(
    input.insertionOrder,
    "rule.insertionOrder",
  );

  const rule = {
    ...input,
    schemaVersion: 1,
    id,
    content,
    kind,
    enabled: input.enabled !== false,
    coordinate,
    ...(category ? { category } : {}),
    ...(budgetClass ? { budgetClass } : {}),
    ...(keys.length > 0 ? { keys } : {}),
    ...(insertionOrder !== undefined ? { insertionOrder } : {}),
  };

  const serialized = JSON.stringify(rule);
  if (serialized.length > MAX_RULE_BYTES) {
    throw new Error("rule is too large; max serialized size is 64KB");
  }
  return rule;
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

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 32);
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
  const strategy = rule.kind === "constant" ? "constant" : "selective";
  return {
    id: lorebookEntryId,
    content: rule.content,
    strategy,
    position: coordinate.position,
    insertionOrder:
      typeof rule.insertionOrder === "number" ? rule.insertionOrder : 500,
    enabled: rule.enabled !== false,
    keys: Array.isArray(rule.keys) ? rule.keys : [],
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
