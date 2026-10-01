import { createHash } from "node:crypto";
import type { EventBus } from "@covel/events";
import type { DataStore } from "@covel/store";
import {
  createWorldModelView,
  type PluginExtensionHost,
  type PluginServiceRegistry,
} from "@covel/runtime";
import {
  uiSlotV1,
  uiSlotNameSchema,
  uiSlotValueSchemas,
  characterVisualCollectionSchema,
  type UiSlotName,
  type UiSlotSnapshot,
  type UiSlotProjectionInput,
  type SubscriptionEvent,
} from "@covel/shared";

export interface UiSlotQuery {
  readonly prefix?: string;
  readonly slot?: UiSlotName;
  readonly key?: string;
}
interface SessionSlots {
  readonly cache: Map<string, UiSlotSnapshot>;
  readonly events: Map<string, UiSlotProjectionInput["events"]>;
  readonly endedTurns: Set<string>;
  readonly dirty: Set<UiSlotName>;
  chain: Promise<void>;
  pending: number;
  timer?: ReturnType<typeof setTimeout>;
}
export interface UiSlotHost {
  get(
    sessionId: string,
    query?: UiSlotQuery,
  ): Promise<readonly UiSlotSnapshot[]>;
  invalidateSession(sessionId: string): void;
  clearSession(sessionId: string): void;
  close(): Promise<void>;
}
const cacheKey = (slot: string, key?: string) =>
  JSON.stringify([slot, key ?? null]);
const terminalEvents = new Set([
  "turn.completed",
  "turn.failed",
  "execution.completed",
  "execution.aborted",
  "execution.commit_failed",
  "error.occurred",
]);

/** Session-scoped, serialized projections; provider code sees only its own data. */
export function createUiSlotHost(args: {
  readonly store: DataStore;
  readonly eventBus: EventBus;
  readonly extensionHost: PluginExtensionHost;
  readonly services: PluginServiceRegistry;
  readonly debounceMs?: number;
  readonly onProjection?: (metric: {
    sessionId: string;
    slot: UiSlotName;
    durationMs: number;
    preview: boolean;
  }) => void;
}): UiSlotHost {
  const sessions = new Map<string, SessionSlots>();
  const abort = new AbortController();
  let closed = false;
  const trimSessions = (keepId?: string) => {
    // Busy sessions own queued work and event state. Allow temporary overflow
    // until they finish, then evict only idle least-recently-used sessions.
    for (const [id, state] of sessions) {
      if (sessions.size <= 256) break;
      if (id === keepId || state.pending > 0 || state.timer) continue;
      sessions.delete(id);
    }
  };
  const sessionState = (id: string): SessionSlots => {
    const existing = sessions.get(id);
    if (existing) {
      sessions.delete(id);
      sessions.set(id, existing);
      return existing;
    }
    const state: SessionSlots = {
      cache: new Map(),
      events: new Map(),
      endedTurns: new Set(),
      dirty: new Set(),
      chain: Promise.resolve(),
      pending: 0,
    };
    sessions.set(id, state);
    trimSessions(id);
    return state;
  };
  const emit = (
    sessionId: string,
    type: string,
    payload: Record<string, unknown>,
  ) => {
    if (closed) return;
    args.eventBus.emit({
      id: crypto.randomUUID(),
      type: "event",
      topic: "plugin",
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { ...payload, _subType: type },
    });
  };
  const enqueue = <T>(
    sessionId: string,
    task: (state: SessionSlots) => Promise<T>,
  ): Promise<T> => {
    const state = sessionState(sessionId);
    state.pending++;
    const result = state.chain.then(() => task(state));
    state.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      state.pending--;
      trimSessions();
    });
  };
  const project = async (
    sessionId: string,
    slots: readonly UiSlotName[],
    turnId?: string,
  ) => {
    const state = sessionState(sessionId);
    if (closed || (turnId && state.endedTurns.has(turnId))) return;
    const session = await args.store.getSession(sessionId);
    if (!session) {
      sessions.delete(sessionId);
      return;
    }
    const world = await createWorldModelView(args.store, sessionId);
    const execution = args.extensionHost.createExecution({
      sessionId,
      locale: session.locale,
      signal: abort.signal,
      readPluginData: (pluginId, namespace) =>
        args.store.listPluginData(sessionId, pluginId, namespace),
      world,
      ...(turnId ? { turnId } : {}),
    });
    for (const slot of slots) {
      const started = performance.now();
      try {
        const result = await execution.run(uiSlotV1, {
          slot,
          previous: null,
          events: turnId ? (state.events.get(turnId) ?? []) : [],
        });
        if (
          closed ||
          sessions.get(sessionId) !== state ||
          (turnId && state.endedTurns.has(turnId))
        )
          continue;
        const values: { key?: string; value: UiSlotSnapshot["value"] }[] = [];
        if (slot === "character.visual@1") {
          const collection =
            result === null
              ? { characters: [] }
              : characterVisualCollectionSchema.parse(result);
          for (const value of collection.characters)
            values.push({ key: value.characterId, value });
          for (const previous of state.cache.values()) {
            if (
              previous.slot === slot &&
              // The keyless placeholder is a slot-level "cleared" marker,
              // not an inventory key: never re-emit it as a removed key.
              previous.key !== undefined &&
              !values.some((entry) => entry.key === previous.key)
            )
              values.push({ key: previous.key, value: null });
          }
          if (!values.length) values.push({ value: null });
          // Keyed characters supersede a keyless "empty" placeholder cached
          // by an earlier projection; drop it instead of leaving it forever.
          else state.cache.delete(cacheKey(slot));
        } else {
          values.push({
            value:
              result === null ? null : uiSlotValueSchemas[slot].parse(result),
          });
        }
        for (const entry of values) {
          const revision = createHash("sha256")
            .update(JSON.stringify(entry.value))
            .digest("hex");
          const snapshot: UiSlotSnapshot = { slot, ...entry, revision };
          if (turnId) {
            emit(sessionId, "ui.slot.preview", { ...snapshot, turnId });
          } else {
            const key = cacheKey(slot, entry.key);
            if (state.cache.get(key)?.revision !== revision) {
              state.cache.set(key, snapshot);
              emit(sessionId, "ui.slot.changed", snapshot);
            }
          }
        }
      } catch {
        if (!closed)
          console.warn("[ui-slots] projection failed", { sessionId, slot });
      } finally {
        args.onProjection?.({
          sessionId,
          slot,
          durationMs: performance.now() - started,
          preview: turnId !== undefined,
        });
      }
    }
  };
  const schedule = (sessionId: string, slots: readonly UiSlotName[]) => {
    if (!slots.length || closed) return;
    const state = sessionState(sessionId);
    for (const slot of slots) state.dirty.add(slot);
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      const dirty = [...state.dirty];
      state.dirty.clear();
      void enqueue(sessionId, () => project(sessionId, dirty)).catch(() => {});
    }, args.debounceMs ?? 50);
    state.timer.unref?.();
  };
  const handle = async (event: SubscriptionEvent) => {
    if (closed || event.type.startsWith("ui.slot.")) return;
    if (
      event.type === "runtime.started" &&
      typeof event.payload.turnId === "string"
    ) {
      sessionState(event.sessionId).endedTurns.delete(event.payload.turnId);
      return;
    }
    const relevant =
      event.type === "plugin-data.changed" ||
      event.type === "domain-event.previewed" ||
      event.type === "plugin.activated" ||
      event.type === "plugin.deactivated" ||
      event.type === "character.upserted" ||
      terminalEvents.has(event.type);
    if (!relevant) return;
    const { sessionId, payload } = event;
    const state = sessionState(sessionId);
    state.pending++;
    try {
      const turnId =
        typeof payload.turnId === "string" ? payload.turnId : undefined;
      if (terminalEvents.has(event.type) && turnId) {
        state.endedTurns.add(turnId);
        if (state.endedTurns.size > 128)
          state.endedTurns.delete(state.endedTurns.values().next().value!);
        state.events.delete(turnId);
        emit(sessionId, "ui.slot.cleared", { turnId });
        schedule(sessionId, uiSlotNameSchema.options);
        return;
      }
      const providers = await args.services.discoverExtensions(
        sessionId,
        uiSlotV1.id,
      );
      const slots = new Set<UiSlotName>();
      for (const provider of providers) {
        const parsed = uiSlotNameSchema.safeParse(provider.slot);
        if (!parsed.success) continue;
        if (event.type === "plugin-data.changed") {
          if (
            provider.pluginId !== payload.pluginId ||
            !Array.isArray(payload.changes)
          )
            continue;
          if (
            payload.changes.some(
              (change: unknown) =>
                change &&
                typeof change === "object" &&
                provider.watch?.includes(
                  String((change as Record<string, unknown>).namespace),
                ),
            )
          )
            slots.add(parsed.data);
        } else if (event.type === "domain-event.previewed") {
          if (provider.preview?.includes(String(payload.topic)))
            slots.add(parsed.data);
        } else slots.add(parsed.data);
      }
      if (event.type === "plugin.deactivated") {
        for (const value of state.cache.values()) slots.add(value.slot);
      }
      if (
        event.type === "domain-event.previewed" &&
        turnId &&
        slots.size &&
        !state.endedTurns.has(turnId)
      ) {
        if (
          typeof payload.topic !== "string" ||
          !payload.data ||
          typeof payload.data !== "object" ||
          Array.isArray(payload.data)
        )
          return;
        state.events.set(
          turnId,
          [
            ...(state.events.get(turnId) ?? []),
            {
              topic: payload.topic,
              data: payload.data as Record<string, unknown>,
              turnId,
              ...(typeof payload.pluginId === "string"
                ? { pluginId: payload.pluginId }
                : {}),
            },
          ].slice(-128),
        );
        await enqueue(sessionId, () => project(sessionId, [...slots], turnId));
      } else schedule(sessionId, [...slots]);
    } finally {
      state.pending--;
      trimSessions();
    }
  };
  const unsubscribe = args.eventBus.onEmit((event) => {
    void handle(event).catch(() => {});
  });
  return {
    async get(sessionId, query = {}) {
      const names = uiSlotNameSchema.options.filter(
        (slot) =>
          (!query.slot || slot === query.slot) &&
          (!query.prefix || slot.startsWith(query.prefix)),
      );
      return enqueue(sessionId, async (state) => {
        const missing = names.filter(
          (slot) =>
            state.dirty.has(slot) ||
            ![...state.cache.values()].some((entry) => entry.slot === slot),
        );
        for (const slot of missing) state.dirty.delete(slot);
        if (missing.length) await project(sessionId, missing);
        if (sessions.get(sessionId) !== state) return [];
        return [...state.cache.values()].filter(
          (entry) =>
            names.includes(entry.slot) &&
            (query.key === undefined || entry.key === query.key),
        );
      });
    },
    invalidateSession(sessionId) {
      schedule(sessionId, uiSlotNameSchema.options);
    },
    clearSession(sessionId) {
      const state = sessions.get(sessionId);
      if (state?.timer) clearTimeout(state.timer);
      for (const turnId of state?.events.keys() ?? [])
        emit(sessionId, "ui.slot.cleared", { turnId });
      sessions.delete(sessionId);
    },
    async close() {
      closed = true;
      unsubscribe();
      abort.abort(new Error("UI slot host closed"));
      for (const state of sessions.values())
        if (state.timer) clearTimeout(state.timer);
      await Promise.allSettled(
        [...sessions.values()].map((state) => state.chain),
      );
      sessions.clear();
    },
  };
}
