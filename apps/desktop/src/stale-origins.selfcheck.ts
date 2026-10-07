/**
 * Runnable self-check for the list of page origins whose storage is cleared.
 * No test framework — `tsx src/stale-origins.selfcheck.ts` throws on the first
 * failing assertion.
 */
import assert from "node:assert/strict";
import { staleLoopbackOrigins } from "./stale-origins.js";

// Every earlier loopback origin once, whatever its two directories; the
// origin of this launch and names of another shape are left alone.
assert.deepEqual(
  staleLoopbackOrigins(
    [
      "http_127.0.0.1_51947.indexeddb.blob",
      "http_127.0.0.1_51947.indexeddb.leveldb",
      "http_127.0.0.1_49321.indexeddb.leveldb",
      "http_127.0.0.1_52000.indexeddb.leveldb",
      "https_example.com_0.indexeddb.leveldb",
      "http_localhost_5173.indexeddb.leveldb",
      "http_127.0.0.1_49321.indexeddb.leveldb.bak",
      ".DS_Store",
    ],
    52000,
  ),
  ["http://127.0.0.1:49321", "http://127.0.0.1:51947"],
);

// A first launch, or a port that never changed: nothing to clear.
assert.deepEqual(staleLoopbackOrigins([], 52000), []);
assert.deepEqual(
  staleLoopbackOrigins(["http_127.0.0.1_52000.indexeddb.leveldb"], 52000),
  [],
);

console.log("stale-origins self-check passed");
