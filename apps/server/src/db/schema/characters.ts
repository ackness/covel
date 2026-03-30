import { pgTable, text, timestamp, jsonb, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";

export const characters = pgTable("characters", {
  id: uuid("id").primaryKey().defaultRandom(),
  branchId: uuid("branch_id")
    .notNull()
    .references(() => branches.id),
  name: text("name").notNull(),
  locale: text("locale"),
  fields: jsonb("fields"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
