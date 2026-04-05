import {
  pgTable,
  text,
  timestamp,
  jsonb,
  uuid,
  integer,
} from "drizzle-orm/pg-core";

// ── Worlds ──────────────────────────────────────────────────────

export const worlds = pgTable("worlds", {
  id: text("id").primaryKey(),
  name: jsonb("name").notNull().$type<string | Record<string, string>>(),
  description: jsonb("description").notNull().$type<string | Record<string, string>>().default(""),
  lore: jsonb("lore").$type<string | Record<string, string>>(),
  locale: text("locale"),
  tags: jsonb("tags").$type<string[]>(),
  dimensions: jsonb("dimensions").$type<Record<string, unknown>>(),
  packageId: text("package_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"),
});

// ── Sessions ────────────────────────────────────────────────────

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  worldId: text("world_id").notNull(),
  status: text("status").notNull().default("active"),
  phase: text("phase").notNull().default("init"),
  presetId: text("preset_id"),
  settings: jsonb("settings").$type<Record<string, unknown>>(),
  taskBindings: jsonb("task_bindings").$type<Record<string, string>>(),
  createdAt: text("created_at").notNull(),
});

// ── Messages ────────────────────────────────────────────────────

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: text("created_at").notNull(),
});

// ── Characters ──────────────────────────────────────────────────

export const characters = pgTable("characters", {
  id: text("id").primaryKey(),
  worldId: text("world_id").notNull(),
  sessionId: text("session_id"),
  name: text("name").notNull(),
  type: text("type").notNull().default("npc"),
  description: text("description"),
  fields: jsonb("fields").$type<Record<string, unknown>>(),
  extensions: jsonb("extensions").$type<Record<string, unknown>>(),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ── Events ──────────────────────────────────────────────────────

export const events = pgTable("events", {
  id: text("id").primaryKey(),
  branchId: text("branch_id").notNull(),
  turnId: text("turn_id").notNull(),
  type: text("type").notNull(),
  source: text("source").notNull(),
  locale: text("locale"),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  createdAt: text("created_at").notNull(),
});

// ── Domain Records ──────────────────────────────────────────────

export const domainRecords = pgTable("domain_records", {
  id: text("id").primaryKey(),
  branchId: text("branch_id").notNull(),
  kind: text("kind").notNull(),
  key: text("key").notNull(),
  value: jsonb("value"),
  summary: text("summary"),
  locale: text("locale"),
  updatedAt: text("updated_at").notNull(),
});

// ── Snapshots ───────────────────────────────────────────────────

export const snapshots = pgTable("snapshots", {
  id: text("id").primaryKey(),
  branchId: text("branch_id").notNull(),
  turnId: text("turn_id").notNull(),
  label: text("label"),
  summary: text("summary"),
  data: jsonb("data").notNull().$type<Record<string, unknown>>(),
  createdAt: text("created_at").notNull(),
});

// ── Trace Events ───────────────────────────────────────────────

export const traceEvents = pgTable("trace_events_store", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  type: text("type").notNull(),
  requestId: text("request_id").notNull(),
  traceId: text("trace_id").notNull(),
  turnId: text("turn_id").notNull(),
  flowId: text("flow_id").notNull(),
  seq: integer("seq").notNull(),
  payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
  createdAt: text("created_at").notNull(),
});

// ── State Patches ──────────────────────────────────────────────

export const statePatches = pgTable("state_patches", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  summary: text("summary").notNull(),
  packageName: text("package_name").notNull(),
  data: jsonb("data"),
  createdAt: text("created_at").notNull(),
});

// ── State Snapshots ────────────────────────────────────────────

export const stateSnapshots = pgTable("state_snapshots", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().unique(),
  data: jsonb("data").notNull().$type<Record<string, unknown>>(),
  createdAt: text("created_at").notNull(),
});
