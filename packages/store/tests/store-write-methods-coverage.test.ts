import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../src/memory/memory-store.js";
import { STORE_WRITE_METHODS } from "../src/store-write-methods.js";

/**
 * Reverse coverage for the serialized write gate.
 *
 * `memory-transaction-rollback.test.ts` already checks the forward direction —
 * every key in `WRITE_METHOD_TOUCHES` names a real store method (map ⊆ store).
 * It does NOT check the reverse: that every mutating store method is registered
 * in `STORE_WRITE_METHODS`. That set is what `serialized-write-gate.ts` consults
 * to decide which methods queue behind an open transaction; a new mutator that
 * ships unregistered would silently skip the gate and its write could be folded
 * into — and lost with — an unrelated rolled-back transaction.
 *
 * This test walks a real store instance and, using a name-prefix heuristic to
 * spot mutators, asserts each one is registered. A future mutator added under a
 * recognised write prefix (set/update/delete/... ) but forgotten in the touches
 * map fails red here.
 */

// Prefixes that unambiguously denote a mutating method on this store surface.
// Read prefixes (get/list/search/has/count/resolve) are deliberately excluded.
const MUTATOR_PREFIXES = [
  "set",
  "update",
  "delete",
  "save",
  "insert",
  "upsert",
  "create",
  "remove",
  "append",
  "patch",
  "add",
  "tag",
  "mark",
  "claim",
  "lock",
  "ensure",
];

// Non-gated methods whose names could trip a prefix but are lifecycle/plumbing,
// not data writes. None currently match MUTATOR_PREFIXES, so this stays empty;
// it documents the intended exclusions if such a method is ever added.
const NON_GATE_ALLOWLIST = new Set<string>([
  "close", // lifecycle: closes the connection, touches no collection
  "withTransaction", // transaction driver, not itself a write
]);

function looksLikeMutator(name: string): boolean {
  return MUTATOR_PREFIXES.some((p) => name.startsWith(p));
}

describe("STORE_WRITE_METHODS reverse coverage", () => {
  it("registers every mutating store method in the write gate set", () => {
    const store = createMemoryStore() as unknown as Record<string, unknown>;

    const suspectedMutators = Object.keys(store).filter(
      (name) =>
        typeof store[name] === "function" &&
        !NON_GATE_ALLOWLIST.has(name) &&
        looksLikeMutator(name),
    );

    // Sanity: the heuristic must actually match something, otherwise the
    // assertion below is vacuously true and guards nothing.
    expect(suspectedMutators.length).toBeGreaterThan(10);

    const unregistered = suspectedMutators.filter(
      (name) => !STORE_WRITE_METHODS.has(name),
    );
    expect(
      unregistered,
      `mutating methods missing from STORE_WRITE_METHODS (serialized write gate ` +
        `will not queue them → lost-write risk): ${unregistered.join(", ")}`,
    ).toEqual([]);
  });
});
