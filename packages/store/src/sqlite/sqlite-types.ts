import type { NodeSqliteDatabase } from "./drizzle-node-sqlite.js";
import * as schema from "./schema.js";

export type SqliteDb = NodeSqliteDatabase<typeof schema>;
export type { SqliteConnection } from "./node-sqlite.js";
