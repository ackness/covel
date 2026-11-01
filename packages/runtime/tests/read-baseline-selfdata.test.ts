import { createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import { selfDataBaselineSuite } from "./helpers/selfdata-baseline-suite.js";

selfDataBaselineSuite("memory", createMemoryStore);
selfDataBaselineSuite("sqlite", () => createSqliteStore(":memory:"));
