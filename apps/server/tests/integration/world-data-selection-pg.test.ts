import { afterAll, describe, it } from "vitest";
import { createPgStore } from "@covel/store/postgres";
import {
  createIsolatedPgDatabase,
  type IsolatedPgDatabase,
} from "./pg-test-db.js";
import { worldDataSelectionScenario } from "../helpers/world-data-selection-scenario.js";

let database: IsolatedPgDatabase | undefined;
try {
  database = await createIsolatedPgDatabase(
    process.env.DATABASE_URL ??
      "postgresql://covel:covel_dev@localhost:5432/covel",
    "covel_world_receivers",
  );
} catch (cause) {
  if (process.env.COVEL_REQUIRE_PG_TESTS === "1")
    throw new Error("PostgreSQL is required for world receiver tests", {
      cause,
    });
}
afterAll(() => database?.cleanup(), 90_000);
describe.skipIf(!database)("inferred world data on PostgreSQL", () => {
  it.each([false, true])(
    "preserves activation, deferral, retry and transactions for portable content: %s",
    async (portable) => {
      const store = await createPgStore(database!.url, { freshSchema: true });
      try {
        await worldDataSelectionScenario(store, portable);
      } finally {
        await store.close();
      }
    },
  );
});
