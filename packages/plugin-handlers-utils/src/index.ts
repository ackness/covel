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
 * Split a comma / fullwidth-comma / newline separated string into a trimmed,
 * de-blanked list (capped at 32 entries). Non-strings yield an empty list.
 */
export function splitList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[,，\n]/)
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
  };
}
