/**
 * Shared validation helpers for proposal commit handlers.
 *
 * Each handler in `session-commit-handlers.ts` repeats the same
 * "type-check → return {committed:false, error}" boilerplate. These helpers
 * collapse that pattern: a validator either returns `undefined` (the value is
 * valid) or a ready-made failed {@link CommitResult} the handler can return
 * verbatim. This keeps behaviour byte-identical to the inline checks while
 * removing 28+ duplicated branches.
 */

import type { CommitResult } from "@covel/shared";

/** Build a failed commit result with a leading error message. */
export function commitError(message: string): CommitResult {
  return { committed: false, error: message };
}

/**
 * Require `value` to be a non-empty string. Returns a failed CommitResult
 * (using `message`) when the check fails, otherwise `undefined`.
 */
export function requireNonEmptyString(
  value: unknown,
  message: string,
): CommitResult | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return commitError(message);
  }
  return undefined;
}

/**
 * Require `value` to be a non-empty array. Returns a failed CommitResult
 * when the check fails, otherwise `undefined`.
 */
export function requireNonEmptyArray(
  value: unknown,
  message: string,
): CommitResult | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return commitError(message);
  }
  return undefined;
}

/**
 * Require `value` to be a string when it is provided (non-`undefined`).
 * Optional fields use this so an absent value passes.
 */
export function requireOptionalString(
  value: unknown,
  message: string,
): CommitResult | undefined {
  if (value !== undefined && typeof value !== "string") {
    return commitError(message);
  }
  return undefined;
}

/**
 * Require `value` to be a number when it is provided (non-`undefined`).
 */
export function requireOptionalNumber(
  value: unknown,
  message: string,
): CommitResult | undefined {
  if (value !== undefined && typeof value !== "number") {
    return commitError(message);
  }
  return undefined;
}

/**
 * Require `value` to be a string array when it is provided (non-`undefined`).
 */
export function requireOptionalStringArray(
  value: unknown,
  message: string,
): CommitResult | undefined {
  if (
    value !== undefined &&
    (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
  ) {
    return commitError(message);
  }
  return undefined;
}

/**
 * Run a sequence of validator results in order, returning the first failure
 * (if any). Mirrors the short-circuit semantics of consecutive `if` guards.
 */
export function firstFailure(
  ...results: readonly (CommitResult | undefined)[]
): CommitResult | undefined {
  for (const result of results) {
    if (result) return result;
  }
  return undefined;
}
