import { pgTable, text, timestamp, jsonb, uuid } from "drizzle-orm/pg-core";

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: text("world_id"),
  status: text("status").notNull().default("active"),
  defaultLocale: text("default_locale").notNull().default("zh-CN"),
  settings: jsonb("settings"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const runPlugins = pgTable("run_plugins", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id),
  pluginId: text("plugin_id").notNull(),
  // TODO: migrate to boolean("enabled") — currently text for historical reasons
  enabled: text("enabled").notNull().default("true"),
  settings: jsonb("settings"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
