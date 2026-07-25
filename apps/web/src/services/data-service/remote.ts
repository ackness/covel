import type {
  MessageRecord,
  SessionRecord,
  StatePatchRecord,
  WorldRecord,
} from "../api.js";
import * as api from "../api.js";
import { isNotFound } from "../api/request.js";
import * as appKv from "../app-kv-store.js";
import type { DataService, WorldPatch } from "./types.js";

/**
 * `null` means "no such record" — nothing else. An auth failure, a 500, or a
 * dead connection must propagate so the caller can say so; mapping them to
 * `null` told a hosted player with an expired owner token that their session
 * did not exist. Matches LocalDataService, which only returns `null` for a
 * genuine miss.
 */
function nullIfMissing(err: unknown): null {
  if (isNotFound(err)) return null;
  throw err;
}

export class RemoteDataService implements DataService {
  async listWorlds() {
    return api.listWorlds();
  }
  async getWorld(id: string) {
    try {
      return await api.getWorld(id);
    } catch (err) {
      return nullIfMissing(err);
    }
  }
  async createWorld(name: string, description: string) {
    return api.createWorld(name, description);
  }
  async saveGeneratedWorld(world: WorldRecord) {
    return world;
  }
  async updateWorld(id: string, patch: WorldPatch) {
    return api.updateWorld(id, patch);
  }

  async listSessions(worldId: string) {
    return api.listSessions(worldId);
  }
  async getSession(sessionId: string) {
    try {
      return await api.getSession(sessionId);
    } catch (err) {
      return nullIfMissing(err);
    }
  }
  async createSession(
    worldId: string,
    presetId?: string,
    id?: string,
    plugins?: string[],
    locale?: string,
  ) {
    return api.createSession(worldId, presetId, id, plugins, locale);
  }
  async updateSession(
    sessionId: string,
    updates: Partial<Pick<SessionRecord, "status" | "presetId">>,
  ) {
    return api.updateSession(sessionId, updates);
  }
  async deleteSession(sessionId: string) {
    return api.deleteSession(sessionId);
  }

  async listMessages(sessionId: string) {
    return api.listMessages(sessionId);
  }
  async listMessagesPage(
    sessionId: string,
    opts: { limit?: number; before?: { createdAt: string; id: string } },
  ) {
    return api.listMessagesPage(sessionId, opts);
  }
  async addMessage(_msg: MessageRecord) {
    // Remote mode: server stores messages during action SSE flow
  }

  async listStatePatches(sessionId: string) {
    return api.listStatePatches(sessionId);
  }
  async addStatePatch(_sessionId: string, _patch: StatePatchRecord) {
    // Remote mode: server stores patches during action SSE flow
  }

  async persistStateSnapshot() {
    // No-op: T3 server handles persistence directly
  }

  async loadStateSnapshot(sessionId: string) {
    // T3: load from server API
    try {
      return await api.loadStateSnapshot(sessionId);
    } catch (err) {
      return nullIfMissing(err);
    }
  }

  async saveSubmittedBlocks(
    sessionId: string,
    blockIds: string[],
    values: Record<string, Record<string, unknown>>,
  ) {
    // T3: use client-side IDB — submitted block state is a UI concern.
    // Could be promoted to a server endpoint if cross-device resume is needed.
    await appKv.saveSubmittedBlocks(sessionId, blockIds, values);
  }

  async loadSubmittedBlocks(sessionId: string) {
    return appKv.getSubmittedBlocks(sessionId);
  }

  async syncToServer() {
    // No-op: server already has the data
  }

  async saveExecutionSteps(sessionId: string, steps: unknown[]) {
    await appKv.saveExecutionSteps(sessionId, steps);
  }

  async loadExecutionSteps(sessionId: string) {
    return appKv.getExecutionSteps(sessionId);
  }
}
