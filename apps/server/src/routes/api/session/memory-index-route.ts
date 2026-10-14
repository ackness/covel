/**
 * The embedding model a session's memory index was built with:
 *
 *   GET  /api/sessions/:id/memory-index          — status, and whether the
 *                                                  configuration still selects it
 *   POST /api/sessions/:id/memory-index/rebuild  — discard the index, lock the
 *                                                  session to the model configured
 *                                                  now and index it again
 *
 * Both read the model configuration of the request (`X-Slot-Config`, and the
 * provider keys for the probe), so the browser sends the same headers as a turn.
 */

import type { Hono } from "hono";
import type { SessionMemoryIndexStatus } from "@covel/shared";
import type { DataStore, SessionRecord } from "@covel/store";
import { supportsVector } from "@covel/store/vector";
import { errorBody } from "../../../api-error.js";
import type { MemoryIndexControl } from "../../../embedding-lock.js";
import { withMemoryIngestLock } from "../../../lib/memory-ingest-lock.js";
import { rateLimiter } from "../../../middleware/rate-limit.js";
import { scheduleMemoryIngest } from "../commit-execution.js";
import { resolveSessionParam } from "./session-guard.js";
import type { SessionRouteEnv } from "./route-env.js";

const UNAVAILABLE: SessionMemoryIndexStatus = {
  available: false,
  locked: null,
  configured: null,
  stale: false,
};

export async function memoryIndexStatus(
  store: DataStore,
  control: MemoryIndexControl | undefined,
  session: SessionRecord,
): Promise<SessionMemoryIndexStatus> {
  if (!control || !supportsVector(store)) return UNAVAILABLE;
  const target = await store.resolveSessionVectorTarget(session.id);
  const configured = control.configured();
  let locked: SessionMemoryIndexStatus["locked"] = null;
  if (target) {
    const model = (await store.listVectorModels()).find(
      (row) => row.id === target.modelRegistryId,
    );
    locked = {
      provider: model?.provider ?? "",
      modelName: model?.modelName ?? target.modelId,
      dim: target.dim,
      lockedAt: session.embeddingLockedAt ?? null,
    };
  }
  return {
    available: true,
    locked,
    configured: configured
      ? { provider: configured.provider, modelName: configured.modelName }
      : null,
    stale: target !== null && configured?.modelId !== target.modelId,
  };
}

export function registerSessionMemoryIndexRoutes(
  routes: Hono<SessionRouteEnv>,
): void {
  routes.get("/:id/memory-index", async (c) => {
    const guard = await resolveSessionParam(c);
    if (!guard.ok) return guard.response;
    return c.json(
      await memoryIndexStatus(
        c.get("store"),
        c.get("memoryIndex"),
        guard.session,
      ),
    );
  });

  routes.post(
    "/:id/memory-index/rebuild",
    rateLimiter({ max: 10 }),
    async (c) => {
      const guard = await resolveSessionParam(c);
      if (!guard.ok) return guard.response;
      const store = c.get("store");
      const control = c.get("memoryIndex");
      if (!control || !supportsVector(store)) {
        return c.json(
          errorBody("This server keeps no vector memory index", {
            code: "memory_index_unavailable",
          }),
          409,
        );
      }
      const sessionId = guard.session.id;
      // Measure the new model before anything is discarded: without a key or
      // with an unreachable endpoint, the old index stays as it was.
      let target;
      try {
        target = await control.configuredTarget();
      } catch (error) {
        return c.json(
          errorBody("The embedding model did not answer", {
            code: "embedding_unavailable",
            details: {
              reason: error instanceof Error ? error.message : String(error),
            },
          }),
          502,
        );
      }
      // The ingestion lock waits out a sweep in flight and holds off the next
      // one until the session is locked to the new model.
      const reset = await withMemoryIngestLock(c, sessionId, async () => {
        const live = await store.getSession(sessionId);
        if (!live || live.createdAt !== guard.session.createdAt) return null;
        const current = await store.resolveSessionVectorTarget(sessionId);
        return store.resetSessionVectorIndex({
          sessionId,
          expectedSessionCreatedAt: live.createdAt,
          expectedModelRegistryId: current?.modelRegistryId ?? null,
          target,
        });
      });
      if (reset === null) {
        return c.json(
          errorBody("Session was replaced while the request was waiting", {
            code: "session_incarnation_changed",
          }),
          409,
        );
      }
      if (!reset) {
        return c.json(
          errorBody("The memory index changed while it was being rebuilt", {
            code: "memory_index_changed",
          }),
          409,
        );
      }
      // Fill the new index in the background, from the first message on.
      scheduleMemoryIngest(c.get("memorySystem"), sessionId);
      const session = (await store.getSession(sessionId)) ?? guard.session;
      return c.json(await memoryIndexStatus(store, control, session));
    },
  );
}
