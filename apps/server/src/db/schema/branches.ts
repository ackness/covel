import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { runs } from "./runs.js";

export const branches = pgTable("branches", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id),
  parentBranchId: uuid("parent_branch_id"),
  name: text("name"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
