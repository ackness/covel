import type { ExtractTablesWithRelations } from "drizzle-orm";
import type {
  PostgresJsDatabase,
  PostgresJsTransaction,
} from "drizzle-orm/postgres-js";

import * as schema from "./schema.js";

export type PgDb =
  | PostgresJsDatabase<typeof schema>
  | PostgresJsTransaction<
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >;
