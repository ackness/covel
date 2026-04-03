import { pgTable, text, integer, jsonb, index } from "drizzle-orm/pg-core";

export const traceEvents = pgTable(
  "sv_trace_events",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    requestId: text("request_id").notNull(),
    traceId: text("trace_id").notNull(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    flowId: text("flow_id").notNull(),
    seq: integer("seq").notNull(),
    timestamp: text("timestamp").notNull(),
    payload: jsonb("payload").notNull().default("{}"),
  },
  (table) => [
    index("idx_sv_trace_events_session").on(table.sessionId),
    index("idx_sv_trace_events_session_turn").on(table.sessionId, table.turnId),
  ],
);
