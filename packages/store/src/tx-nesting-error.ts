/**
 * Shared error builder for the scoped-transaction nesting guardrail.
 *
 * `DataStore.withTransaction` cannot be safely nested (a `withTransaction` call
 * issued from inside another `withTransaction` callback). This module produces a
 * single, consistent error message for that case across every backend.
 *
 * Browser-safe: this file MUST stay free of Node-only imports
 * (`node:async_hooks`, `node:fs`, …) because the browser `IdbStore` bundle
 * imports it. The Node-only AsyncLocalStorage guard lives in the sibling
 * `tx-nesting-guard.ts`, which IdbStore never imports.
 */

/**
 * Build the canonical "nested withTransaction" error.
 *
 * @param storeLabel Backend store class name, e.g. `"SqliteStore"`.
 * @param backend    Short backend id used in prose, e.g. `"sqlite"`.
 * @param reason     Why nesting is unsafe on this backend (deadlock vs.
 *                   non-atomic independent connection).
 */
export function nestedWithTransactionError(
  storeLabel: string,
  backend: string,
  reason: string,
): Error {
  return new Error(
    `${storeLabel}: nested withTransaction is not supported on the ${backend} ` +
      `backend; ${reason}. Flatten the nested call, or perform the inner writes ` +
      `directly through the outer callback's tx scope.`,
  );
}

/**
 * Reason string for the single-connection serialized backends (Sqlite / Memory
 * / IndexedDB). These serialize concurrent `withTransaction` calls through a
 * promise chain, so a nested call would queue behind — and therefore deadlock —
 * the very transaction that is awaiting it.
 */
export const SERIALIZED_NESTING_REASON =
  "it would deadlock the serialized transaction chain (the inner call queues " +
  "behind the outer transaction that is awaiting it)";

/**
 * Reason string for PostgreSQL. PgStore runs each `withTransaction` on an
 * independent pooled connection, so nesting does not deadlock — but the inner
 * call would run as a separate transaction that is NOT atomic with the outer
 * one (an outer rollback would not undo the inner commit). Rejecting keeps the
 * cross-backend contract uniform and prevents that silent atomicity surprise.
 */
export const INDEPENDENT_CONNECTION_NESTING_REASON =
  "the inner call would run on an independent pooled connection and would not " +
  "be atomic with the outer transaction";
