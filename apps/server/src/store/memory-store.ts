/**
 * In-memory domain stores for first-release demo.
 *
 * Provides worlds, sessions, and messages storage.
 * All data lives in process memory — lost on restart.
 */
import { SEED_WORLDS } from "./seed-worlds.js";

export interface WorldRecord {
  id: string;
  name: string;
  description: string;
  /** Extended world lore for system prompt context. */
  lore?: string;
  tags?: string[];
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  worldId: string;
  status: "active" | "waiting_for_input" | "archived";
  presetId?: string;
  taskBindings?: Record<string, string>;
  createdAt: string;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: "system" | "user" | "assistant";
  content: string;
  createdAt: string;
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createMemoryStore() {
  const worlds = new Map<string, WorldRecord>();
  const sessions = new Map<string, SessionRecord>();
  const messages = new Map<string, MessageRecord[]>(); // sessionId → messages

  // ── Worlds ──────────────────────────────────────────────────────

  function listWorlds(): WorldRecord[] {
    return Array.from(worlds.values()).sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt)
    );
  }

  function createWorld(name: string, description: string, opts?: { lore?: string; tags?: string[] }): WorldRecord {
    const world: WorldRecord = {
      id: uid("world"),
      name,
      description,
      lore: opts?.lore,
      tags: opts?.tags,
      createdAt: new Date().toISOString(),
    };
    worlds.set(world.id, world);
    return world;
  }

  function getWorld(id: string): WorldRecord | undefined {
    return worlds.get(id);
  }

  // ── Sessions ────────────────────────────────────────────────────

  function listSessions(worldId: string): SessionRecord[] {
    return Array.from(sessions.values())
      .filter((s) => s.worldId === worldId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function createSession(opts: {
    worldId: string;
    presetId?: string;
    taskBindings?: Record<string, string>;
  }): SessionRecord {
    const session: SessionRecord = {
      id: uid("session"),
      worldId: opts.worldId,
      status: "active",
      presetId: opts.presetId,
      taskBindings: opts.taskBindings,
      createdAt: new Date().toISOString(),
    };
    sessions.set(session.id, session);
    messages.set(session.id, []);
    return session;
  }

  function getSession(id: string): SessionRecord | undefined {
    return sessions.get(id);
  }

  function updateSession(
    id: string,
    patch: Partial<Pick<SessionRecord, "status" | "presetId" | "taskBindings">>
  ): SessionRecord | undefined {
    const session = sessions.get(id);
    if (!session) return undefined;
    // Whitelist: only apply known mutable fields
    if (patch.status !== undefined) session.status = patch.status;
    if (patch.presetId !== undefined) session.presetId = patch.presetId;
    if (patch.taskBindings !== undefined) session.taskBindings = patch.taskBindings;
    return session;
  }

  // ── Messages ────────────────────────────────────────────────────

  function listMessages(sessionId: string): MessageRecord[] {
    return messages.get(sessionId) ?? [];
  }

  function addMessage(
    sessionId: string,
    role: MessageRecord["role"],
    content: string
  ): MessageRecord {
    const msg: MessageRecord = {
      id: uid("msg"),
      sessionId,
      role,
      content,
      createdAt: new Date().toISOString(),
    };
    let list = messages.get(sessionId);
    if (!list) {
      list = [];
      messages.set(sessionId, list);
    }
    list.push(msg);
    return msg;
  }

  // ── Seed preset worlds ──────────────────────────────────────────
  for (const seed of SEED_WORLDS) {
    createWorld(seed.name, seed.description, { lore: seed.lore, tags: seed.tags });
  }

  return {
    listWorlds,
    createWorld,
    getWorld,
    listSessions,
    createSession,
    getSession,
    updateSession,
    listMessages,
    addMessage,
  };
}

export type MemoryStore = ReturnType<typeof createMemoryStore>;
