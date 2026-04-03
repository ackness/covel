/**
 * Server store interface — async-first, backend-agnostic.
 *
 * Both MemoryStore and PgServerStore satisfy this interface.
 * Routes use this type so the backend can be swapped via config.
 */
import type { CharacterCard, CharacterCreateInput, SessionPhase, WorldDimensions } from "@covel/shared";

export interface WorldRecord {
  id: string;
  name: string;
  description: string;
  lore?: string;
  locale?: string;
  tags?: string[];
  dimensions?: WorldDimensions;
  createdAt: string;
  updatedAt?: string;
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
  turnId?: string;
  runtimeId?: string;
  block?: Record<string, unknown>;
  createdAt: string;
}

export interface StatePatchRecord {
  id: string;
  sessionId: string;
  summary: string;
  packageName: string;
  data?: unknown;
  createdAt: string;
}

export interface TraceEvent {
  type: string;
  requestId: string;
  traceId: string;
  sessionId: string;
  turnId: string;
  flowId: string;
  seq: number;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface ServerStore {
  // Worlds
  listWorlds(): Promise<WorldRecord[]>;
  createWorld(
    name: string,
    description: string,
    opts?: { lore?: string; locale?: string; tags?: string[]; dimensions?: WorldDimensions },
  ): Promise<WorldRecord>;
  getWorld(id: string): Promise<WorldRecord | undefined>;
  updateWorld(
    id: string,
    patch: Partial<Omit<WorldRecord, "id" | "createdAt">>,
  ): Promise<WorldRecord | undefined>;

  // Sessions
  listSessions(worldId: string): Promise<SessionRecord[]>;
  createSession(opts: {
    worldId: string;
    presetId?: string;
    taskBindings?: Record<string, string>;
  }): Promise<SessionRecord>;
  getSession(id: string): Promise<SessionRecord | undefined>;
  updateSession(
    id: string,
    patch: Partial<Pick<SessionRecord, "status" | "phase" | "presetId" | "taskBindings">>,
  ): Promise<SessionRecord | undefined>;
  updateSessionPhase(id: string, phase: SessionPhase): Promise<SessionRecord | undefined>;
  /** Delete a session and all associated data (messages, patches, characters, traces, snapshots). */
  deleteSession(id: string): Promise<boolean>;

  // Messages
  listMessages(sessionId: string): Promise<MessageRecord[]>;
  addMessage(
    sessionId: string,
    role: MessageRecord["role"],
    content: string,
    meta?: { turnId?: string; runtimeId?: string; block?: Record<string, unknown> },
  ): Promise<MessageRecord>;

  // State Patches
  listStatePatches(sessionId: string): Promise<StatePatchRecord[]>;
  addStatePatch(
    sessionId: string,
    patch: { id: string; summary: string; packageName: string; data?: unknown },
  ): Promise<StatePatchRecord>;

  // Characters
  createCharacter(sessionId: string, input: CharacterCreateInput): Promise<CharacterCard>;
  getCharacter(id: string): Promise<CharacterCard | undefined>;
  getSessionCharacters(sessionId: string): Promise<CharacterCard[]>;
  updateCharacter(id: string, patch: Partial<CharacterCard>): Promise<CharacterCard | undefined>;

  // Trace Events
  addTraceEvent(sessionId: string, event: TraceEvent): Promise<void>;
  listTraceEvents(sessionId: string): Promise<TraceEvent[]>;

  // State Snapshots (post-commit full state)
  saveStateSnapshot(sessionId: string, snapshot: Record<string, unknown>): Promise<void>;
  getStateSnapshot(sessionId: string): Promise<Record<string, unknown> | null>;
}
