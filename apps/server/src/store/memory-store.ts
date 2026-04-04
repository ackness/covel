/**
 * In-memory domain stores for first-release demo.
 *
 * Provides worlds, sessions, and messages storage.
 * All data lives in process memory — lost on restart.
 */
import { randomUUID } from "node:crypto";
import type { CharacterCard, CharacterCreateInput, I18nText, SessionPhase, WorldDimensions } from "@covel/shared";
import { humanId } from "human-id";
import { loadWorldPackages } from "./world-package-loader.js";
import type {
  ServerStore,
  WorldRecord,
  SessionRecord,
  MessageRecord,
  StatePatchRecord,
  TraceEvent,
} from "./types.js";

function uid(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/** Generate a human-readable session ID: "word-word-word-xxxx" */
function humanSessionId(): string {
  const words = humanId({ separator: "-", capitalize: false });
  const hex = Math.random().toString(16).slice(2, 6);
  return `${words}-${hex}`;
}

/** Max trace events kept per session (ring buffer). */
const MAX_TRACE_EVENTS_PER_SESSION = 2000;

export async function createMemoryStore(worldsDir?: string): Promise<ServerStore> {
  const worlds = new Map<string, WorldRecord>();
  const sessions = new Map<string, SessionRecord>();
  const messages = new Map<string, MessageRecord[]>(); // sessionId → messages
  const statePatches = new Map<string, StatePatchRecord[]>(); // sessionId → patches
  const characters = new Map<string, CharacterCard>();
  const traceEvents = new Map<string, TraceEvent[]>(); // sessionId → events
  const stateSnapshots = new Map<string, Record<string, unknown>>(); // sessionId → snapshot

  // ── Worlds ──────────────────────────────────────────────────────

  async function listWorlds(): Promise<WorldRecord[]> {
    return Array.from(worlds.values()).sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt)
    );
  }

  async function createWorld(
    name: I18nText,
    description: I18nText,
    opts?: { id?: string; lore?: I18nText; locale?: string; tags?: string[]; dimensions?: WorldDimensions },
  ): Promise<WorldRecord> {
    const world: WorldRecord = {
      id: opts?.id ?? uid("world"),
      name,
      description,
      lore: opts?.lore,
      locale: opts?.locale,
      tags: opts?.tags,
      dimensions: opts?.dimensions,
      createdAt: new Date().toISOString(),
    };
    worlds.set(world.id, world);
    return world;
  }

  async function getWorld(id: string): Promise<WorldRecord | undefined> {
    return worlds.get(id);
  }

  async function updateWorld(
    id: string,
    patch: Partial<Omit<WorldRecord, "id" | "createdAt">>,
  ): Promise<WorldRecord | undefined> {
    const world = worlds.get(id);
    if (!world) return undefined;
    const updated: WorldRecord = {
      ...world,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    worlds.set(id, updated);
    return updated;
  }

  // ── Sessions ────────────────────────────────────────────────────

  async function listSessions(worldId: string): Promise<SessionRecord[]> {
    return Array.from(sessions.values())
      .filter((s) => s.worldId === worldId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function createSession(opts: {
    id?: string;
    worldId: string;
    presetId?: string;
    taskBindings?: Record<string, string>;
  }): Promise<SessionRecord> {
    const session: SessionRecord = {
      id: opts.id ?? humanSessionId(),
      worldId: opts.worldId,
      status: "active",
      phase: "init",
      presetId: opts.presetId,
      taskBindings: opts.taskBindings,
      createdAt: new Date().toISOString(),
    };
    sessions.set(session.id, session);
    messages.set(session.id, []);
    return session;
  }

  async function getSession(id: string): Promise<SessionRecord | undefined> {
    return sessions.get(id);
  }

  async function updateSession(
    id: string,
    patch: Partial<Pick<SessionRecord, "status" | "phase" | "presetId" | "taskBindings">>
  ): Promise<SessionRecord | undefined> {
    const session = sessions.get(id);
    if (!session) return undefined;
    const validPatch: Partial<SessionRecord> = {};
    if (patch.status !== undefined) validPatch.status = patch.status;
    if (patch.phase !== undefined) validPatch.phase = patch.phase;
    if (patch.presetId !== undefined) validPatch.presetId = patch.presetId;
    if (patch.taskBindings !== undefined) validPatch.taskBindings = patch.taskBindings;
    const updated = { ...session, ...validPatch };
    sessions.set(id, updated);
    return updated;
  }

  async function updateSessionPhase(id: string, phase: SessionPhase): Promise<SessionRecord | undefined> {
    const session = sessions.get(id);
    if (!session) return undefined;
    const updated = { ...session, phase };
    sessions.set(id, updated);
    return updated;
  }

  async function deleteSession(id: string): Promise<boolean> {
    if (!sessions.has(id)) return false;
    sessions.delete(id);
    messages.delete(id);
    statePatches.delete(id);
    traceEvents.delete(id);
    stateSnapshots.delete(id);
    // Remove characters belonging to this session
    for (const [charId, card] of characters) {
      if (card.runId === id) characters.delete(charId);
    }
    return true;
  }

  // ── Messages ────────────────────────────────────────────────────

  async function listMessages(sessionId: string): Promise<MessageRecord[]> {
    return messages.get(sessionId) ?? [];
  }

  async function addMessage(
    sessionId: string,
    role: MessageRecord["role"],
    content: string,
    meta?: { turnId?: string; runtimeId?: string; block?: Record<string, unknown> },
  ): Promise<MessageRecord> {
    const msg: MessageRecord = {
      id: uid("msg"),
      sessionId,
      role,
      content,
      ...(meta?.turnId ? { turnId: meta.turnId } : {}),
      ...(meta?.runtimeId ? { runtimeId: meta.runtimeId } : {}),
      ...(meta?.block ? { block: meta.block } : {}),
      createdAt: new Date().toISOString(),
    };
    const list = messages.get(sessionId) ?? [];
    messages.set(sessionId, [...list, msg]);
    return msg;
  }

  async function clearMessages(sessionId: string): Promise<void> {
    messages.delete(sessionId);
  }

  // ── State Patches ──────────────────────────────────────────────────

  async function listStatePatches(sessionId: string): Promise<StatePatchRecord[]> {
    return statePatches.get(sessionId) ?? [];
  }

  async function addStatePatch(
    sessionId: string,
    patch: { id: string; summary: string; packageName: string; data?: unknown },
  ): Promise<StatePatchRecord> {
    const record: StatePatchRecord = {
      id: patch.id,
      sessionId,
      summary: patch.summary,
      packageName: patch.packageName,
      data: patch.data,
      createdAt: new Date().toISOString(),
    };
    const list = statePatches.get(sessionId) ?? [];
    statePatches.set(sessionId, [...list, record]);
    return record;
  }

  // ── Characters ──────────────────────────────────────────────────

  async function createCharacter(sessionId: string, input: CharacterCreateInput): Promise<CharacterCard> {
    const session = sessions.get(sessionId);
    if (!session) throw new Error("Session not found: " + sessionId);
    const card: CharacterCard = {
      id: uid("char"),
      worldId: session.worldId,
      runId: sessionId,
      name: input.name,
      type: input.type ?? "player",
      description: input.description ?? "",
      fields: input.fields ?? {},
      extensions: {},
      createdAt: new Date().toISOString(),
      version: 1,
    };
    characters.set(card.id, card);
    return card;
  }

  async function getCharacter(id: string): Promise<CharacterCard | undefined> {
    return characters.get(id);
  }

  async function getSessionCharacters(sessionId: string): Promise<CharacterCard[]> {
    return Array.from(characters.values()).filter((c) => c.runId === sessionId);
  }

  async function updateCharacter(id: string, patch: Partial<CharacterCard>): Promise<CharacterCard | undefined> {
    const card = characters.get(id);
    if (!card) return undefined;
    const updated: CharacterCard = {
      ...card,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.portrait !== undefined ? { portrait: patch.portrait } : {}),
      ...(patch.fields !== undefined ? { fields: patch.fields } : {}),
      ...(patch.extensions !== undefined ? { extensions: patch.extensions } : {}),
      version: card.version + 1,
    };
    characters.set(id, updated);
    return updated;
  }

  // ── Trace Events ────────────────────────────────────────────────

  async function addTraceEvent(sessionId: string, event: TraceEvent): Promise<void> {
    const existing = traceEvents.get(sessionId) ?? [];
    // Immutable append with ring buffer: drop oldest when exceeding max
    const appended = [...existing, event];
    const updated = appended.length > MAX_TRACE_EVENTS_PER_SESSION
      ? appended.slice(appended.length - MAX_TRACE_EVENTS_PER_SESSION)
      : appended;
    traceEvents.set(sessionId, updated);
  }

  async function listTraceEvents(sessionId: string): Promise<TraceEvent[]> {
    return traceEvents.get(sessionId) ?? [];
  }

  // ── State Snapshots ──────────────────────────────────────────────

  async function saveStateSnapshot(sessionId: string, snapshot: Record<string, unknown>): Promise<void> {
    stateSnapshots.set(sessionId, snapshot);
  }

  async function getStateSnapshot(sessionId: string): Promise<Record<string, unknown> | null> {
    return stateSnapshots.get(sessionId) ?? null;
  }

  // ── Seed preset worlds from worlds/ directory ──────────────────
  // Uses stable IDs (world_<packageId>) for idempotency.
  if (worldsDir) {
    const seeds = await loadWorldPackages(worldsDir);
    for (const seed of seeds) {
      const world: WorldRecord = {
        id: seed.id,
        packageId: seed.packageId,
        name: seed.name,
        description: seed.description,
        lore: seed.lore,
        locale: seed.locale,
        tags: seed.tags,
        dimensions: seed.dimensions,
        createdAt: new Date().toISOString(),
      };
      worlds.set(world.id, world);
    }
  }

  return {
    listWorlds,
    createWorld,
    getWorld,
    updateWorld,
    listSessions,
    createSession,
    getSession,
    updateSession,
    updateSessionPhase,
    deleteSession,
    listMessages,
    addMessage,
    clearMessages,
    listStatePatches,
    addStatePatch,
    createCharacter,
    getCharacter,
    getSessionCharacters,
    updateCharacter,
    addTraceEvent,
    listTraceEvents,
    saveStateSnapshot,
    getStateSnapshot,
  };
}

export type MemoryStore = Awaited<ReturnType<typeof createMemoryStore>>;
