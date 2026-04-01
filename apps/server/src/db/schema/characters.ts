import { pgTable, text, timestamp, jsonb, uuid, integer } from "drizzle-orm/pg-core";
import { runs } from "./runs.js";

export const characters = pgTable("characters", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: text("world_id"),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id),
  name: text("name").notNull(),
  type: text("type").notNull().default("npc"),
  description: text("description").notNull().default(""),
  portrait: text("portrait"),
  fields: jsonb("fields").notNull().default({}),
  extensions: jsonb("extensions").notNull().default({}),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
