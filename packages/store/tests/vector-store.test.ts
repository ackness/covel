import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import { runVectorStoreContractTests } from "../src/contract/vector-store-contract.js";
import { createMemoryStore } from "../src/memory/memory-store.js";
import { createSqliteStore } from "../src/sqlite/sqlite-store.js";
import { supportsVector } from "../src/vector-store.js";

// ── MemoryStore: always supports VectorStoreCapability ────────

runVectorStoreContractTests("MemoryStore", () => {
	const store = createMemoryStore();
	return store;
});

// ── SqliteStore: supports when sqlite-vec loads ──────────────

runVectorStoreContractTests("SqliteStore (sqlite-vec)", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "covel-vec-test-"));
	const dbPath = path.join(tmpDir, "test.db");
	const store = createSqliteStore(dbPath);
	if (!supportsVector(store)) {
		throw new Error(
			"SqliteStore does not expose VectorStoreCapability — sqlite-vec failed to load. Install sqlite-vec or skip this suite.",
		);
	}
	return store;
});
