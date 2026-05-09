import { mergeSessionPatch, normalizeSessionRecord } from "../types.js";
import {
  deleteArrayRowsBySession,
  deleteMapRowsBySession,
} from "./collection-helpers.js";
import type { MemoryState, MemoryStoreMethods } from "./memory-types.js";

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
      deleteArrayRowsBySession(state.turnResults, id);
      deleteArrayRowsBySession(state.runtimeResults, id);
      deleteArrayRowsBySession(state.toolCalls, id);
      deleteArrayRowsBySession(state.stateSchemas, id);
      deleteArrayRowsBySession(state.stateChanges, id);
      deleteArrayRowsBySession(state.events, id);
      deleteArrayRowsBySession(state.approvals, id);
      deleteArrayRowsBySession(state.messages, id);
      deleteArrayRowsBySession(state.traceEvents, id);
      deleteArrayRowsBySession(state.turnMessages, id);
      deleteArrayRowsBySession(state.playerInputs, id);
      deleteArrayRowsBySession(state.sessionSummaries, id);
      deleteArrayRowsBySession(state.runtimeOutputs, id);
      deleteArrayRowsBySession(state.interactionRecords, id);
      deleteMapRowsBySession(state.stateEntries, id);
      deleteMapRowsBySession(state.characters, id);
      deleteMapRowsBySession(state.pluginData, id);
      deleteMapRowsBySession(state.pluginConfigs, id);
      deleteMapRowsBySession(state.snapshots, id);
      deleteMapRowsBySession(state.suspensions, id);
      deleteMapRowsBySession(state.workingMemoryEntries, id);
      deleteMapRowsBySession(state.worldDataImportLedger, id);
      deleteMapRowsBySession(state.lorebookEntries, id);
      deleteMapRowsBySession(state.vectorRows, id);
      state.sessionVectorTargets.delete(id);
    },
  };
}
