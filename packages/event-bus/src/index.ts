// ── Types ───────────────────────────────────────────────────────────
export type {
  CovelEvent,
  EventSource,
  EventMeta,
  EventCategory,
  EventResult,
  EventBus,
  ScopedEventBus,
  EventHandler,
  EventMiddleware,
  SubscribeOptions,
  ScopeOptions,
  Unsubscribe,
  ScopedLogger,
  LoggerFields,
} from "./types.js";

// ── EventBus ────────────────────────────────────────────────────────
export { createEventBus } from "./event-bus.js";

// ── ScopedLogger ────────────────────────────────────────────────────
export { createScopedLogger, type LogSink, type LogEntry } from "./scoped-logger.js";

// ── System Events ───────────────────────────────────────────────────
export {
  SystemEvents,
  TriggerEvents,
  RuntimeBusEvents,
  DomainEventExamples,
} from "./system-events.js";
