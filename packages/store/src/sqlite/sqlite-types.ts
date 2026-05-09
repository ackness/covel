import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";

export type SqliteDb = BetterSQLite3Database<typeof schema>;
export type SqliteConnection = Database.Database;
