import { runStoreContractTests } from "../src/contract/store-contract.js";
import { createSqliteStore } from "../src/sqlite/sqlite-store.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

runStoreContractTests("SqliteStore", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "covel-sqlite-test-"));
	const dbPath = path.join(tmpDir, "test.db");
	return createSqliteStore(dbPath);
});
