/**
 * The names of every mutating `DataStore` method.
 *
 * Derived from `WRITE_METHOD_TOUCHES` — the map MemoryStore already maintains
 * to decide which collections a transaction must snapshot — so there is one
 * list, not two that can drift. `tests/memory-transaction-rollback.test.ts`
 * pins every key there against a real store method.
 *
 * Consumed by the serialized write gate on single-connection backends to
 * decide which methods must queue behind an open transaction.
 */

import { WRITE_METHOD_TOUCHES } from "./memory/transaction-methods.js";

export const STORE_WRITE_METHODS: ReadonlySet<string> = new Set(
  Object.keys(WRITE_METHOD_TOUCHES),
);
