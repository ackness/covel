import { afterAll, describe, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import { createPgStore } from "@covel/store/postgres";
import {
  createIsolatedPgDatabase,
  type IsolatedPgDatabase,
} from "./pg-test-db.js";
import { datasetBackendScenario } from "../helpers/dataset-backend-scenarios.js";

let database: IsolatedPgDatabase | undefined;
try {
  database = await createIsolatedPgDatabase(
    process.env.DATABASE_URL ??
      "postgresql://covel:covel_dev@localhost:5432/covel",
    "covel_test_dataset_writes",
  );
} catch (cause) {
  if (process.env.COVEL_REQUIRE_PG_TESTS === "1")
    throw new Error("PostgreSQL is required for dataset write tests", {
      cause,
    });
}
afterAll(async () => {
  await database?.cleanup();
}, 90_000);

for (const [name, create] of [
  ["memory", async () => createMemoryStore()],
  ["sqlite", async () => createSqliteStore(":memory:")],
  ["postgres", async () => createPgStore(database!.url, { freshSchema: true })],
] as const) {
  describe.skipIf(name === "postgres" && !database)(
    `dataset destination rules on ${name}`,
    () => {
      it("keeps import creation, sync changes and ledgers atomic while RPC persists per call", async () => {
        const store = await create();
        try {
          await datasetBackendScenario(store);
        } finally {
          await store.close();
        }
      });
    },
  );
}
