import type {
  CovelEvent,
  EventBus,
  EventHandler,
  EventMiddleware,
  EventResult,
  EventSource,
  ScopedEventBus,
  ScopeOptions,
  SubscribeOptions,
  Unsubscribe,
} from "./types.js";

// ── Pattern matching ────────────────────────────────────────────────

/**
 * Match an event type against a subscription pattern.
 * Supports:
 *   - Exact match: "turn.start"
 *   - Wildcard suffix: "turn.*" matches "turn.start", "turn.input"
 *   - Double wildcard: "**" matches everything
 *   - Single segment wildcard: "*.completed" matches "quest.completed"
 */
function matchPattern(pattern: string, eventType: string): boolean {
  if (pattern === "**") return true;
  if (pattern === eventType) return true;

  const patternParts = pattern.split(".");
  const typeParts = eventType.split(".");

  if (patternParts.length !== typeParts.length) {
    // Allow trailing wildcard to match any depth
    if (patternParts[patternParts.length - 1] === "**") {
      const prefix = patternParts.slice(0, -1);
      for (let i = 0; i < prefix.length; i++) {
        if (prefix[i] !== "*" && prefix[i] !== typeParts[i]) return false;
      }
      return typeParts.length >= prefix.length;
    }
    return false;
  }

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i] === "*") continue;
    if (patternParts[i] !== typeParts[i]) return false;
  }
  return true;
}

function matchSource(filter: Partial<EventSource>, source?: EventSource): boolean {
  if (!source) return false;
  if (filter.pluginId !== undefined && filter.pluginId !== source.pluginId) return false;
  if (filter.runtimeId !== undefined && filter.runtimeId !== source.runtimeId) return false;
  if (filter.system !== undefined && filter.system !== source.system) return false;
  return true;
}

// ── Subscription ────────────────────────────────────────────────────

interface Subscription {
  pattern: string;
  handler: EventHandler;
  options?: SubscribeOptions;
  once?: boolean;
}

// ── Implementation ──────────────────────────────────────────────────

export function createEventBus(): EventBus {
  const subscriptions: Subscription[] = [];
  const middlewares: EventMiddleware[] = [];

  function addSubscription(sub: Subscription): Unsubscribe {
    subscriptions.push(sub);
    return () => {
      const idx = subscriptions.indexOf(sub);
      if (idx !== -1) subscriptions.splice(idx, 1);
    };
  }

  function on(pattern: string, handler: EventHandler, options?: SubscribeOptions): Unsubscribe {
    return addSubscription({ pattern, handler, options });
  }

  function once(pattern: string, handler: EventHandler, options?: SubscribeOptions): Unsubscribe {
    return addSubscription({ pattern, handler, options, once: true });
  }

  function off(pattern: string, handler: EventHandler): void {
    for (let i = subscriptions.length - 1; i >= 0; i--) {
      if (subscriptions[i].pattern === pattern && subscriptions[i].handler === handler) {
        subscriptions.splice(i, 1);
      }
    }
  }

  function use(middleware: EventMiddleware): Unsubscribe {
    middlewares.push(middleware);
    return () => {
      const idx = middlewares.indexOf(middleware);
      if (idx !== -1) middlewares.splice(idx, 1);
    };
  }

  async function emit(event: CovelEvent): Promise<EventResult> {
    // Stamp timestamp if missing
    const stamped: CovelEvent = {
      ...event,
      meta: {
        ...event.meta,
        timestamp: event.meta?.timestamp ?? new Date().toISOString(),
      },
    };

    // Run middleware chain
    let middlewareIndex = 0;
    const runMiddleware = async (): Promise<void> => {
      if (middlewareIndex < middlewares.length) {
        const mw = middlewares[middlewareIndex++];
        await mw(stamped, runMiddleware);
      }
    };
    if (middlewares.length > 0) {
      await runMiddleware();
    }

    // Find matching subscriptions
    const matched: Subscription[] = [];
    const toRemove: Subscription[] = [];

    for (const sub of subscriptions) {
      if (!matchPattern(sub.pattern, stamped.type)) continue;
      if (sub.options?.category && stamped.meta?.category !== sub.options.category) continue;
      if (sub.options?.source && !matchSource(sub.options.source, stamped.source)) continue;
      matched.push(sub);
      if (sub.once) toRemove.push(sub);
    }

    // Remove once-subscriptions before executing handlers
    for (const sub of toRemove) {
      const idx = subscriptions.indexOf(sub);
      if (idx !== -1) subscriptions.splice(idx, 1);
    }

    // Execute handlers with error isolation
    const errors: Error[] = [];
    for (const sub of matched) {
      try {
        await sub.handler(stamped);
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    return { handlerCount: matched.length, errors };
  }

  function scope(scopeId: string, options?: ScopeOptions): ScopedEventBus {
    return createScopedEventBus(bus, scopeId, options);
  }

  const bus: EventBus = { emit, on, once, off, use, scope };
  return bus;
}

// ── Scoped EventBus ─────────────────────────────────────────────────

function createScopedEventBus(
  parent: EventBus,
  scopeId: string,
  options?: ScopeOptions,
): ScopedEventBus {
  const unsubscribes: Unsubscribe[] = [];

  function trackUnsub(unsub: Unsubscribe): Unsubscribe {
    unsubscribes.push(unsub);
    return () => {
      unsub();
      const idx = unsubscribes.indexOf(unsub);
      if (idx !== -1) unsubscribes.splice(idx, 1);
    };
  }

  async function emit(event: CovelEvent): Promise<EventResult> {
    const withSource: CovelEvent = {
      ...event,
      source: event.source ?? options?.defaultSource,
    };
    return parent.emit(withSource);
  }

  function on(pattern: string, handler: EventHandler, subOptions?: SubscribeOptions): Unsubscribe {
    return trackUnsub(parent.on(pattern, handler, subOptions));
  }

  function once(pattern: string, handler: EventHandler, subOptions?: SubscribeOptions): Unsubscribe {
    return trackUnsub(parent.once(pattern, handler, subOptions));
  }

  function off(pattern: string, handler: EventHandler): void {
    parent.off(pattern, handler);
  }

  function use(middleware: EventMiddleware): Unsubscribe {
    return trackUnsub(parent.use(middleware));
  }

  function scopeChild(childId: string, childOptions?: ScopeOptions): ScopedEventBus {
    return createScopedEventBus(scopedBus, `${scopeId}.${childId}`, childOptions);
  }

  function dispose(): void {
    for (const unsub of [...unsubscribes]) {
      unsub();
    }
    unsubscribes.length = 0;
  }

  const scopedBus: ScopedEventBus = {
    scopeId,
    emit,
    on,
    once,
    off,
    use,
    scope: scopeChild,
    dispose,
  };

  return scopedBus;
}
