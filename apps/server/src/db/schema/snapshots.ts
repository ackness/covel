import { pgTable, text, timestamp, jsonb, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";

export const snapshots = pgTable("snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  branchId: uuid("branch_id")
    .notNull()
    .references(() => branches.id),
  turnId: text("turn_id"),
  label: text("label"),
  summary: text("summary"),
  data: jsonb("data"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
