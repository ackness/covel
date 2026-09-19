import type { MessageRecord, StatePatchRecord, WorldRecord } from "../api.js";
import * as api from "../api.js";
import { isNotFound } from "../api/request.js";
import { ignoreError } from "../../lib/ignore-error.js";
import {
  captureRemoteUiStamp,
  discardRemoteUiOwner,
  invalidateRemoteUiScope,
  listRemoteUiOwners,
  RemoteUiCacheChangedError,
  useRemoteUiCache,
  type RemoteUiScope,
} from "../storage/remote-ui-cache.js";
import type {
  DataService,
  SessionPatch,
  SessionUiOwner,
  WorldPatch,
} from "./types.js";

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

function validateCacheSession(
  session: SessionUiOwner,
  sessionId: string,
): void {
  if (
    session.id !== sessionId ||
    typeof session.incarnation !== "string" ||
    !session.incarnation ||
    (session.worldId != null && typeof session.worldId !== "string")
  ) {
    throw new Error("Remote session response cannot verify cache ownership");
  }
}

export class RemoteDataService implements DataService {
  private async useCache(
    sessionId: string,
    session: SessionUiOwner,
    update?: Parameters<typeof useRemoteUiCache>[2],
  ) {
    if (
      session?.id !== sessionId ||
      typeof session.incarnation !== "string" ||
      !session.incarnation
    ) {
      throw new Error(
        "Remote UI cache requires the captured session incarnation",
      );
    }
    const owner = {
      sessionId,
      worldId: session.worldId ?? "",
      incarnation: session.incarnation,
    };
    const owned = structuredClone(update);
    const stamp = await captureRemoteUiStamp(owner);
    // A previously verified binding can accept display updates locally. Reads
    // still verify the server, and the transaction fences replacement/deletion.
    if (
      owned &&
      stamp.cachedIncarnation === owner.incarnation &&
      stamp.cachedWorldId === owner.worldId
    ) {
      return useRemoteUiCache(owner, stamp, owned);
    }
    let live;
    try {
      live = await api.getSession(sessionId, { silentErrors: true });
    } catch (error) {
      if (isNotFound(error)) {
        await discardRemoteUiOwner(owner).catch(
          ignoreError("discard missing remote session cache"),
        );
      }
      throw error;
    }
    validateCacheSession(live, sessionId);
    if (
      live.incarnation !== owner.incarnation ||
      (live.worldId ?? "") !== owner.worldId
    ) {
      await discardRemoteUiOwner(owner).catch(
        ignoreError("discard replaced remote session cache"),
      );
      throw new RemoteUiCacheChangedError();
    }
    return useRemoteUiCache(owner, stamp, owned);
  }

  private async reconcileCaches(scope: RemoteUiScope): Promise<void> {
    const owners = await listRemoteUiOwners(scope);
    for (const owner of owners) {
      let discard = false;
      try {
        const live = await api.getSession(owner.sessionId, {
          silentErrors: true,
        });
        validateCacheSession(live, owner.sessionId);
        discard = live.incarnation !== owner.incarnation;
      } catch (error) {
        if (isNotFound(error)) discard = true;
        else ignoreError("verify remote cache after deletion")(error);
      }
      if (discard) {
        await discardRemoteUiOwner(owner).catch(
          ignoreError("discard remote cache after deletion"),
        );
      }
    }
  }

  private async deleteWithCacheCleanup(
    scope: RemoteUiScope,
    remove: () => Promise<void>,
  ): Promise<void> {
    // Cache failures must not prevent authoritative deletion. Epoch changes on
    // both sides fence reads that overlap the server mutation, including retries.
    await invalidateRemoteUiScope(scope).catch(
      ignoreError("invalidate remote cache before deletion"),
    );
    try {
      await remove();
    } finally {
      await invalidateRemoteUiScope(scope).catch(
        ignoreError("invalidate remote cache after deletion"),
      );
      await this.reconcileCaches(scope).catch(
        ignoreError("clean remote caches after deletion"),
      );
    }
  }

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
    return api.createWorld({ name, description });
  }
  async saveGeneratedWorld(world: WorldRecord) {
    return world;
  }
  async updateWorld(id: string, patch: WorldPatch) {
    return api.updateWorld(id, patch);
  }
  async deleteWorld(id: string) {
    return this.deleteWithCacheCleanup({ kind: "world", id }, () =>
      api.deleteWorld(id),
    );
  }
  async prepareWorldForServer() {
    // No-op: the remote store is already the server's authority.
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
    loreOverride?: string,
  ) {
    return api.createSession(
      worldId,
      presetId,
      id,
      plugins,
      locale,
      loreOverride,
    );
  }
  async updateSession(sessionId: string, updates: SessionPatch) {
    return api.updateSession(sessionId, updates);
  }
  async deleteSession(sessionId: string) {
    return this.deleteWithCacheCleanup({ kind: "session", id: sessionId }, () =>
      api.deleteSession(sessionId),
    );
  }

  async listMessages(sessionId: string) {
    return api.listMessages(sessionId);
  }
  async listMessagesPage(
    sessionId: string,
    opts: { limit?: number; cursor?: import("@covel/shared").PageCursor },
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

  async saveSubmittedBlocks(
    sessionId: string,
    blockIds: string[],
    values: Record<string, Record<string, unknown>>,
    owner: SessionUiOwner,
  ) {
    await this.useCache(sessionId, owner, {
      kind: "submitted",
      ids: blockIds,
      values,
    });
  }

  async loadSubmittedBlocks(sessionId: string, owner: SessionUiOwner) {
    return (await this.useCache(sessionId, owner)).submitted;
  }

  async syncToServer() {
    // No-op: server already has the data
  }

  async stageServerCommit() {
    // No-op: remote mode commits directly to the authoritative server store.
  }

  async commitFromServer() {
    // No-op: remote mode commits directly to the authoritative server store.
  }

  async saveExecutionSteps(
    sessionId: string,
    steps: unknown[],
    owner: SessionUiOwner,
  ) {
    await this.useCache(sessionId, owner, { kind: "steps", steps });
  }

  async loadExecutionSteps(sessionId: string, owner: SessionUiOwner) {
    return (await this.useCache(sessionId, owner)).steps;
  }
}
