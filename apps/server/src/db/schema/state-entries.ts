import { pgTable, text, timestamp, jsonb, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";

export const stateEntries = pgTable("state_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  branchId: uuid("branch_id")
    .notNull()
    .references(() => branches.id),
  scope: text("scope").notNull(),
  key: text("key").notNull(),
  value: jsonb("value"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const statePatchCommits = pgTable("state_patch_commits", {
  id: uuid("id").primaryKey().defaultRandom(),
  branchId: uuid("branch_id")
    .notNull()
    .references(() => branches.id),
  turnId: text("turn_id").notNull(),
  runtimeId: text("runtime_id").notNull(),
  pluginId: text("plugin_id").notNull(),
  traceId: text("trace_id"),
  patches: jsonb("patches"),
  committedAt: timestamp("committed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
