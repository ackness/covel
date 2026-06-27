import { SESSION_SCOPED_TABLES } from "../table-registry.js";
import { mergeSessionPatch, normalizeSessionRecord } from "../types.js";
import {
  deleteArrayRowsBySession,
  deleteMapRowsBySession,
} from "./collection-helpers.js";
import type { MemoryState, MemoryStoreMethods } from "./memory-types.js";

type SessionRow = { sessionId: string };

export function createSessionMethods(state: MemoryState): MemoryStoreMethods {
  return {
    async createSession(session) {
      state.sessions.set(session.id, normalizeSessionRecord(session));
    },

    async getSession(id) {
      const session = state.sessions.get(id);
      return session ? normalizeSessionRecord(session) : null;
    },

    async updateSession(id, patch) {
      const existing = state.sessions.get(id);
      if (!existing) return;
      state.sessions.set(id, mergeSessionPatch(existing, patch));
    },

    async listSessions() {
      return [...state.sessions.values()].map(normalizeSessionRecord);
    },

    async deleteSession(id) {
      state.sessions.delete(id);
      // Cascade across every registered session-scoped collection.
      for (const { memoryKey, memoryKind } of SESSION_SCOPED_TABLES) {
        const collection = state[memoryKey];
        if (memoryKind === "map") {
          deleteMapRowsBySession(collection as Map<string, SessionRow>, id);
        } else {
          deleteArrayRowsBySession(collection as SessionRow[], id);
        }
      }
      // Vector storage is MemoryStore-only (no SQL table); clean it explicitly.
      deleteMapRowsBySession(state.vectorRows, id);
      state.sessionVectorTargets.delete(id);
    },
  };
}
