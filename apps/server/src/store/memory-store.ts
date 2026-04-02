/**
 * In-memory domain stores for first-release demo.
 *
 * Provides worlds, sessions, and messages storage.
 * All data lives in process memory — lost on restart.
 */
import type { CharacterCard, CharacterCreateInput, CharacterType, SessionPhase } from "@covel/shared";
import { humanId } from "human-id";
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
  phase: SessionPhase;
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

/** Generate a human-readable session ID: "word-word-word-xxxx" */
function humanSessionId(): string {
  const words = humanId({ separator: "-", capitalize: false });
  const hex = Math.random().toString(16).slice(2, 6);
  return `${words}-${hex}`;
}

export function createMemoryStore() {
  const worlds = new Map<string, WorldRecord>();
  const sessions = new Map<string, SessionRecord>();
  const messages = new Map<string, MessageRecord[]>(); // sessionId → messages
  const characters = new Map<string, CharacterCard>();

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
      id: humanSessionId(),
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

  function getSession(id: string): SessionRecord | undefined {
    return sessions.get(id);
  }

  function updateSession(
    id: string,
    patch: Partial<Pick<SessionRecord, "status" | "phase" | "presetId" | "taskBindings">>
  ): SessionRecord | undefined {
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

  function updateSessionPhase(id: string, phase: SessionPhase): SessionRecord | undefined {
    const session = sessions.get(id);
    if (!session) return undefined;
    const updated = { ...session, phase };
    sessions.set(id, updated);
    return updated;
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
    const list = messages.get(sessionId) ?? [];
    messages.set(sessionId, [...list, msg]);
    return msg;
  }

  // ── Characters ──────────────────────────────────────────────────

  function createCharacter(sessionId: string, input: CharacterCreateInput): CharacterCard {
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

  function getCharacter(id: string): CharacterCard | undefined {
    return characters.get(id);
  }

  function getSessionCharacters(sessionId: string): CharacterCard[] {
    return Array.from(characters.values()).filter((c) => c.runId === sessionId);
  }

  function updateCharacter(id: string, patch: Partial<CharacterCard>): CharacterCard | undefined {
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
    updateSessionPhase,
    listMessages,
    addMessage,
    createCharacter,
    getCharacter,
    getSessionCharacters,
    updateCharacter,
  };
}

export type MemoryStore = ReturnType<typeof createMemoryStore>;
