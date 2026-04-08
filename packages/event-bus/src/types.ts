// ── Event Types ─────────────────────────────────────────────────────

export type EventCategory = "trigger" | "domain" | "runtime-bus";

export interface EventSource {
  pluginId?: string;
  runtimeId?: string;
  system?: boolean;
}

export interface EventMeta {
  sessionId?: string;
  turnId?: string;
  traceId?: string;
  timestamp?: string;
  category?: EventCategory;
}

export interface CovelEvent {
  type: string;
  payload: unknown;
  source?: EventSource;
  meta?: EventMeta;
}

export interface EventResult {
  /** Number of handlers that received this event. */
  handlerCount: number;
  /** Errors from handlers (isolated — never propagate to emitter). */
  errors: Error[];
}

// ── Subscription Types ──────────────────────────────────────────────

export interface SubscribeOptions {
  /** Filter by event source. */
  source?: Partial<EventSource>;
  /** Filter by event category. */
  category?: EventCategory;
}

export type EventHandler = (event: CovelEvent) => void | Promise<void>;
export type Unsubscribe = () => void;

// ── Middleware ───────────────────────────────────────────────────────

export type EventMiddleware = (
  event: CovelEvent,
  next: () => Promise<void>,
) => void | Promise<void>;

// ── Scoped Bus Options ──────────────────────────────────────────────

export interface ScopeOptions {
  /** Default source to attach to all events emitted from this scope. */
  defaultSource?: EventSource;
}

// ── EventBus Interface ──────────────────────────────────────────────

export interface EventBus {
  emit(event: CovelEvent): Promise<EventResult>;
  on(pattern: string, handler: EventHandler, options?: SubscribeOptions): Unsubscribe;
  once(pattern: string, handler: EventHandler, options?: SubscribeOptions): Unsubscribe;
  off(pattern: string, handler: EventHandler): void;
  use(middleware: EventMiddleware): Unsubscribe;
  scope(scopeId: string, options?: ScopeOptions): ScopedEventBus;
}

export interface ScopedEventBus extends EventBus {
  readonly scopeId: string;
  /** Remove all subscriptions registered through this scope. */
  dispose(): void;
}

// ── ScopedLogger Interface ──────────────────────────────────────────

export interface ScopedLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, error?: Error | unknown, data?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): ScopedLogger;
}

export interface LoggerFields {
  pluginId?: string;
  runtimeId?: string;
  sessionId?: string;
  turnId?: string;
  traceId?: string;
  toolId?: string;
  [key: string]: unknown;
}
