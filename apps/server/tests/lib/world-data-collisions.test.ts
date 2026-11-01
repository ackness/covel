import { it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import {
  COLLISION_CASES,
  worldDataCollisionScenario,
} from "../helpers/world-data-collision-scenario.js";

for (const [backend, create] of [
  ["memory", createMemoryStore],
  ["sqlite", () => createSqliteStore(":memory:")],
] as const)
  it.each(COLLISION_CASES)(
    `${backend} preserves imported rows, ledgers and media on a %s collision`,
    async (kind) => {
      const store = create();
      try {
        await worldDataCollisionScenario(store, kind);
      } finally {
        await store.close();
      }
    },
  );
