/**
 * Pure business logic for game event management.
 * All functions are immutable — they return new state objects.
 */

export type EventType = "quest" | "combat" | "social" | "world" | "system";
export type EventStatus = "active" | "evolved" | "resolved" | "ended";
export type EventVisibility = "known" | "hidden" | "secret";

export interface GameEvent {
  readonly eventId: string;
  readonly eventType: EventType;
  readonly name: string;
  readonly description: string;
  readonly status: EventStatus;
  readonly visibility: EventVisibility;
  readonly parentEventId?: string;
  readonly source: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EventState {
  readonly events: readonly GameEvent[];
}

export const EMPTY_STATE: EventState = { events: [] };

export interface CreateEventInput {
  readonly eventType: EventType;
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly parentEventId?: string;
  readonly visibility?: EventVisibility;
}

export interface CreateEventResult {
  readonly state: EventState;
  readonly event: GameEvent;
}

export interface EventTreeNode {
  readonly event: GameEvent;
  readonly children: readonly EventTreeNode[];
}

/**
 * Create a new game event with status "active".
 */
export function createEvent(
  state: EventState,
  input: CreateEventInput,
  generateId: () => string = () => crypto.randomUUID(),
  now: string = new Date().toISOString(),
): CreateEventResult {
  const event: GameEvent = {
    eventId: generateId(),
    eventType: input.eventType,
    name: input.name,
    description: input.description,
    status: "active",
    visibility: input.visibility ?? "known",
    parentEventId: input.parentEventId,
    source: input.source,
    createdAt: now,
    updatedAt: now,
  };

  const newState: EventState = {
    events: [...state.events, event],
  };

  return { state: newState, event };
}

/**
 * Evolve an event — updates description and sets status to "evolved".
 * Throws if event not found or not in active/evolved status.
 */
export function evolveEvent(
  state: EventState,
  eventId: string,
  description: string,
  now: string = new Date().toISOString(),
): EventState {
  const index = state.events.findIndex((e) => e.eventId === eventId);
  if (index === -1) {
    throw new Error(`Event not found: ${eventId}`);
  }

  const existing = state.events[index];
  if (existing.status !== "active" && existing.status !== "evolved") {
    throw new Error(
      `Cannot evolve event ${eventId} with status ${existing.status}`,
    );
  }

  const updated: GameEvent = {
    ...existing,
    description,
    status: "evolved",
    updatedAt: now,
  };

  const newEvents = state.events.map((e, i) => (i === index ? updated : e));
  return { events: newEvents };
}

/**
 * Resolve an event — sets status to "resolved".
 * Optionally updates description with a resolution message.
 * Throws if event not found or not in active/evolved status.
 */
export function resolveEvent(
  state: EventState,
  eventId: string,
  resolution?: string,
  now: string = new Date().toISOString(),
): EventState {
  const index = state.events.findIndex((e) => e.eventId === eventId);
  if (index === -1) {
    throw new Error(`Event not found: ${eventId}`);
  }

  const existing = state.events[index];
  if (existing.status !== "active" && existing.status !== "evolved") {
    throw new Error(
      `Cannot resolve event ${eventId} with status ${existing.status}`,
    );
  }

  const updated: GameEvent = {
    ...existing,
    description: resolution ?? existing.description,
    status: "resolved",
    updatedAt: now,
  };

  const newEvents = state.events.map((e, i) => (i === index ? updated : e));
  return { events: newEvents };
}

/**
 * End an event — sets status to "ended".
 * Can end active, evolved, or resolved events.
 * Throws if event not found or already ended.
 */
export function endEvent(
  state: EventState,
  eventId: string,
  reason?: string,
  now: string = new Date().toISOString(),
): EventState {
  const index = state.events.findIndex((e) => e.eventId === eventId);
  if (index === -1) {
    throw new Error(`Event not found: ${eventId}`);
  }

  const existing = state.events[index];
  if (existing.status === "ended") {
    throw new Error(
      `Cannot end event ${eventId} with status ${existing.status}`,
    );
  }

  const updated: GameEvent = {
    ...existing,
    description: reason ?? existing.description,
    status: "ended",
    updatedAt: now,
  };

  const newEvents = state.events.map((e, i) => (i === index ? updated : e));
  return { events: newEvents };
}

/**
 * Get all events with status "active" or "evolved".
 */
export function getActiveEvents(state: EventState): readonly GameEvent[] {
  return state.events.filter(
    (e) => e.status === "active" || e.status === "evolved",
  );
}

/**
 * Get all events of a specific type.
 */
export function getEventsByType(
  state: EventState,
  eventType: EventType,
): readonly GameEvent[] {
  return state.events.filter((e) => e.eventType === eventType);
}

/**
 * Get all child events for a given parent event ID.
 */
export function getChildEvents(
  state: EventState,
  parentEventId: string,
): readonly GameEvent[] {
  return state.events.filter((e) => e.parentEventId === parentEventId);
}

/**
 * Build a hierarchical tree structure from flat events.
 * Returns only root-level nodes (events without a parentEventId).
 */
export function buildEventTree(state: EventState): readonly EventTreeNode[] {
  const childrenMap = new Map<string, GameEvent[]>();

  for (const event of state.events) {
    if (event.parentEventId) {
      const siblings = childrenMap.get(event.parentEventId) ?? [];
      childrenMap.set(event.parentEventId, [...siblings, event]);
    }
  }

  function buildNode(event: GameEvent): EventTreeNode {
    const childEvents = childrenMap.get(event.eventId) ?? [];
    return {
      event,
      children: childEvents.map(buildNode),
    };
  }

  return state.events
    .filter((e) => !e.parentEventId)
    .map(buildNode);
}

/**
 * Build a human-readable event summary for context injection.
 * Only includes active and evolved events.
 */
export function getEventSummary(state: EventState, locale: string): string {
  const isZh = locale.startsWith("zh");
  const active = getActiveEvents(state);

  if (active.length === 0) {
    return isZh ? "当前没有进行中的事件。" : "No active events.";
  }

  const typeLabelsZh: Record<EventType, string> = {
    quest: "任务",
    combat: "战斗",
    social: "社交",
    world: "世界",
    system: "系统",
  };

  const typeLabelsEn: Record<EventType, string> = {
    quest: "Quest",
    combat: "Combat",
    social: "Social",
    world: "World",
    system: "System",
  };

  const statusLabelsZh: Record<EventStatus, string> = {
    active: "进行中",
    evolved: "已演变",
    resolved: "已解决",
    ended: "已结束",
  };

  const lines: string[] = [];
  for (const event of active) {
    const typeLabel = isZh
      ? typeLabelsZh[event.eventType]
      : typeLabelsEn[event.eventType];

    const statusLabel = isZh
      ? statusLabelsZh[event.status]
      : event.status;

    lines.push(
      `[${typeLabel}][${statusLabel}] ${event.name}: ${event.description}`,
    );
  }

  return lines.join("\n");
}
