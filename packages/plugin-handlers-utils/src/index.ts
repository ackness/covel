/**
 * @covel/plugin-handlers-utils — pure helper utilities shared by function-runtime
 * plugin handlers (`handler.js`).
 *
 * These were previously duplicated verbatim across several plugins. They are
 * side-effect-free pure functions plus a single proposal factory, and depend
 * only on the Public Plugin API types (`@covel/shared`). No DB, ORM, kernel
 * internals, or framework components are referenced.
 */

import type { Proposal, ProposalType } from "@covel/shared";

// ── String / list helpers ────────────────────────────────────────

/**
 * Coerce a value to a trimmed non-empty string or throw a descriptive error.
 *
 * @param value - Candidate value (typically from a manual payload / form).
 * @param field - Field name used in the error message.
 * @returns The trimmed string.
 */
export function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Trim a string and return it, or `undefined` when blank / non-string.
 */
export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * Parse a finite number from a number or numeric string, else `undefined`.
 */
export function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Parse an integer from a number or numeric string, else `undefined`.
 */
export function optionalInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * Normalize a value into a trimmed, de-blanked string list (capped at 32
 * entries). Strings are split on comma / fullwidth-comma / newline; arrays keep
 * their string items. Anything else yields an empty list.
 */
export function splitList(value: unknown): string[] {
  const parts = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? value.split(/[,，\n]/)
      : [];
  return parts
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 32);
}

// ── Record helpers ───────────────────────────────────────────────

export interface CompactRecordOptions {
  /**
   * When `true`, empty arrays are dropped in addition to `undefined` values.
   * Defaults to `false` (only `undefined` values are dropped).
   */
  readonly dropEmptyArrays?: boolean;
}

/**
 * Return a new object with `undefined` values removed. When
 * `dropEmptyArrays` is set, empty-array values are removed too.
 */
export function compactRecord<T extends Record<string, unknown>>(
  value: T,
  options: CompactRecordOptions = {},
): Record<string, unknown> {
  const dropEmptyArrays = options.dropEmptyArrays === true;
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (entry === undefined) return false;
      if (dropEmptyArrays && Array.isArray(entry)) return entry.length > 0;
      return true;
    }),
  );
}

// ── Manual-entity helpers ────────────────────────────────────────

/**
 * Dispatch a manual RPC payload to one of three entity shapes:
 *   1. `{entity}Json` — a JSON string (parsed; throws on invalid JSON)
 *   2. `{entity}Form` — a form object (converted via `fromForm`)
 *   3. `{entity}`     — a raw object
 *
 * Returns `undefined` when `payload` is not a plain object. Previously
 * copy-pasted as `read<Entity>Payload` across the manual-entity handlers.
 *
 * @param payload - The manual RPC payload (`ctx.manualPayload`).
 * @param entity - Entity name, e.g. `"blueprint"` reads `blueprintJson` /
 *   `blueprintForm` / `blueprint`.
 * @param fromForm - Converts a `{entity}Form` object into the raw entity shape.
 */
export function readManualEntity(
  payload: unknown,
  entity: string,
  fromForm: (form: Record<string, unknown>) => unknown,
): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const json = record[`${entity}Json`];
  if (typeof json === "string" && json.trim().length > 0) {
    try {
      return JSON.parse(json);
    } catch {
      throw new Error(`manualPayload.${entity}Json must be valid JSON`);
    }
  }
  const form = record[`${entity}Form`];
  if (form && typeof form === "object") {
    return fromForm(form as Record<string, unknown>);
  }
  return record[entity];
}

export interface EntityEnvelopeOptions {
  /** Entity name used in every error message, e.g. `"blueprint"`. */
  readonly entity: string;
  /** Identifier field name. Defaults to `"id"`. */
  readonly idField?: string;
  /** Pattern the identifier must match. */
  readonly idPattern: RegExp;
  /** Error message thrown when the identifier fails `idPattern`. */
  readonly idError: string;
  /**
   * Layer entity-specific fields onto the validated
   * `{ ...value, schemaVersion: 1, [idField]: id }` base before the size guard.
   */
  readonly build?: (base: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Validate the shared manual-entity envelope and return the normalized object.
 * Runs the checks every manual-entity handler repeats:
 *   1. `value` is a plain object (else `manualPayload.<entity> must be an object`)
 *   2. `value[idField]` is a non-empty string matching `idPattern`
 *   3. `value.schemaVersion` is absent or exactly 1
 *   4. the built object serializes to <= 64KB
 */
export function assertEntityEnvelope(
  value: unknown,
  options: EntityEnvelopeOptions,
): Record<string, unknown> {
  const { entity, idField = "id", idPattern, idError, build } = options;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`manualPayload.${entity} must be an object`);
  }
  const input = value as Record<string, unknown>;
  const id = normalizeRequiredString(input[idField], `${entity}.${idField}`);
  if (!idPattern.test(id)) {
    throw new Error(idError);
  }
  const schemaVersion = input.schemaVersion ?? 1;
  if (schemaVersion !== 1) {
    throw new Error(`${entity}.schemaVersion must be 1`);
  }
  const base: Record<string, unknown> = {
    ...input,
    schemaVersion: 1,
    [idField]: id,
  };
  const built = build ? build(base) : base;
  if (JSON.stringify(built).length > 65_536) {
    throw new Error(`${entity} is too large; max serialized size is 64KB`);
  }
  return built;
}

/**
 * Pick the string matching a session locale's language. Prefix-matches the
 * language subtag (`zh-CN` → `zh`) and returns `en` for any non-`zh` or
 * undefined locale. Extracted from the byte-identical `pick(locale, zh, en)`
 * previously copied across plugin handlers/guards.
 *
 * @param locale - Session locale, e.g. `"zh-CN"`, `"en"`, or `undefined`.
 * @param zh - Chinese string.
 * @param en - English (default) string.
 */
export function pickLocaleText(
  locale: string | undefined,
  zh: string,
  en: string,
): string {
  const lang = typeof locale === "string" ? locale.split("-")[0] : "";
  return lang === "zh" ? zh : en;
}

// ── Proposal factory ─────────────────────────────────────────────

/**
 * Minimal handler-context shape required to build a proposal. A structural
 * subset of `FunctionHandlerContext` from `@covel/plugin-loader` — kept local
 * so this package stays dependency-light and Public-API-only.
 */
export interface ProposalContext {
  readonly pluginId: string;
  readonly runtimeId?: string;
  readonly turnId: string;
  readonly sessionId: string;
}

/**
 * Construct a kernel `Proposal` envelope from a handler context.
 *
 * Mirrors the verbatim `makeProposal(ctx, now, type, payload)` helper that was
 * previously copy-pasted into multiple handlers.
 *
 * @param ctx - Handler context (provides ids).
 * @param now - ISO timestamp for the proposal.
 * @param type - Proposal type.
 * @param payload - Proposal payload.
 */
export function makeProposal(
  ctx: ProposalContext,
  now: string,
  type: ProposalType,
  payload: Record<string, unknown>,
): Proposal {
  // `Proposal` is a discriminated union; this factory accepts a generic
  // payload because plugin handlers build proposals from loosely-typed data
  // that the commit handlers validate at commit time. The single cast is the
  // construction boundary.
  return {
    id: crypto.randomUUID(),
    type,
    source: {
      pluginId: ctx.pluginId,
      runtimeId: ctx.runtimeId ?? ctx.pluginId,
    },
    turnId: ctx.turnId,
    sessionId: ctx.sessionId,
    payload,
    timestamp: now,
  } as unknown as Proposal;
}
