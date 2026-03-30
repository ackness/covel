import { pgTable, text, timestamp, jsonb, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  branchId: uuid("branch_id")
    .notNull()
    .references(() => branches.id),
  turnId: text("turn_id"),
  type: text("type").notNull(),
  source: text("source"),
  locale: text("locale"),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
