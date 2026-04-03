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
  listWorlds(): WorldRecord[];
  createWorld(
    name: string,
    description: string,
    opts?: { lore?: string; locale?: string; tags?: string[]; dimensions?: WorldDimensions },
  ): WorldRecord;
  getWorld(id: string): WorldRecord | undefined;
  updateWorld(
    id: string,
    patch: Partial<Omit<WorldRecord, "id" | "createdAt">>,
  ): WorldRecord | undefined;

  // Sessions
  listSessions(worldId: string): SessionRecord[];
  createSession(opts: {
    worldId: string;
    presetId?: string;
    taskBindings?: Record<string, string>;
  }): SessionRecord;
  getSession(id: string): SessionRecord | undefined;
  updateSession(
    id: string,
    patch: Partial<Pick<SessionRecord, "status" | "phase" | "presetId" | "taskBindings">>,
  ): SessionRecord | undefined;
  updateSessionPhase(id: string, phase: SessionPhase): SessionRecord | undefined;

  // Messages
  listMessages(sessionId: string): MessageRecord[];
  addMessage(
    sessionId: string,
    role: MessageRecord["role"],
    content: string,
    meta?: { turnId?: string; runtimeId?: string; block?: Record<string, unknown> },
  ): MessageRecord;

  // State Patches
  listStatePatches(sessionId: string): StatePatchRecord[];
  addStatePatch(
    sessionId: string,
    patch: { id: string; summary: string; packageName: string; data?: unknown },
  ): StatePatchRecord;

  // Characters
  createCharacter(sessionId: string, input: CharacterCreateInput): CharacterCard;
  getCharacter(id: string): CharacterCard | undefined;
  getSessionCharacters(sessionId: string): CharacterCard[];
  updateCharacter(id: string, patch: Partial<CharacterCard>): CharacterCard | undefined;

  // Trace Events
  addTraceEvent(sessionId: string, event: TraceEvent): void;
  listTraceEvents(sessionId: string): TraceEvent[];
}
