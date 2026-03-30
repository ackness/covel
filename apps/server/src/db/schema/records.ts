import { pgTable, text, timestamp, jsonb, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";

export const records = pgTable("records", {
  id: uuid("id").primaryKey().defaultRandom(),
  branchId: uuid("branch_id")
    .notNull()
    .references(() => branches.id),
  kind: text("kind").notNull(),
  key: text("key").notNull(),
  value: jsonb("value"),
  summary: text("summary"),
  locale: text("locale"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const recordEdges = pgTable("record_edges", {
  id: uuid("id").primaryKey().defaultRandom(),
  branchId: uuid("branch_id")
    .notNull()
    .references(() => branches.id),
  fromRecordId: uuid("from_record_id")
    .notNull()
    .references(() => records.id),
  toRecordId: uuid("to_record_id")
    .notNull()
    .references(() => records.id),
  relation: text("relation").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
