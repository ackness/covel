import type {
  MessageRecord,
  SessionRecord,
  StatePatchRecord,
  WorldRecord,
} from "../api.js";
import * as api from "../api.js";
import * as appKv from "../app-kv-store.js";
import type { DataService, WorldPatch } from "./types.js";

export class RemoteDataService implements DataService {
  async listWorlds() {
    return api.listWorlds();
  }
  async getWorld(id: string) {
    try {
      return await api.getWorld(id);
    } catch {
      return null;
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
    } catch {
      return null;
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
    } catch {
      return null;
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
