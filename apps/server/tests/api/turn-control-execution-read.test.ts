import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore } from "@covel/store/memory";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { registerActiveTurn } from "../../src/routes/api/turn-control.js";
import { closeTestApi } from "../helpers/close-api.js";

const sessionId = "execution-read";
const operatorToken = "synthetic-execution-read-operator";

function gate() {
  return Promise.withResolvers<void>();
}

describe("execution reads through the bootstrap response barrier", () => {
  let root: string;
  let api: ApiBootstrapResult;
  let store: ReturnType<typeof createMemoryStore>;
  let lock: ReturnType<typeof createInProcessSessionLock>;
  let ownerToken: string;

  async function createSession() {
    const response = await api.app.request("/api/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${operatorToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: sessionId }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { ownerToken: string };
    return body.ownerToken;
  }

  function status(token = ownerToken, id = sessionId) {
    return api.app.request(`/api/sessions/${id}/execution`, {
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function seedRetry(content: string) {
    await store.addTraceEvent({
      id: crypto.randomUUID(),
      sessionId,
      turnId: "interrupted-turn",
      traceId: "interrupted-turn",
      type: "turn.started",
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        recoveryAction: { type: "send_message", payload: { content } },
      },
    });
  }

  beforeEach(async () => {
    vi.stubEnv("DEPLOYMENT_TIER", "commercial");
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", operatorToken);
    root = await mkdtemp(join(tmpdir(), "covel-execution-read-"));
    store = createMemoryStore();
    lock = createInProcessSessionLock();
    api = await bootstrapApi({
      pluginsDir: root,
      covelHome: root,
      store,
      storeBackend: "memory",
      sessionLock: lock,
      llmAdapter: {
        async generate() {
          throw new Error("Execution reads must not call an LLM");
        },
      },
    });
    ownerToken = await createSession();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeTestApi(api);
    await store?.close();
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it.each([false, true])(
    "rejects an authorized old read after deletion (recreated: %s)",
    async (recreate) => {
      const entered = gate();
      const resume = gate();
      const tryWithLock = lock.tryWithLock.bind(lock);
      // Pause after owner authorization, but BEFORE acquiring the read lock:
      // real DELETE must be able to finish while this old request is suspended.
      vi.spyOn(lock, "tryWithLock").mockImplementationOnce(async (id, fn) => {
        entered.resolve();
        await resume.promise;
        return tryWithLock(id, fn);
      });
      const oldRead = status();
      const secret = "synthetic-new-owner-private-retry";
      try {
        await entered.promise;
        const deleted = await api.app.request(`/api/sessions/${sessionId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${ownerToken}` },
        });
        expect(deleted.status).toBe(200);
        if (recreate) {
          const newOwner = await createSession();
          expect(newOwner).not.toBe(ownerToken);
          await seedRetry(secret);
          const fresh = await status(newOwner);
          expect(fresh.status).toBe(200);
          expect(await fresh.json()).toMatchObject({
            state: "interrupted",
            retry: { type: "send_message", payload: { content: secret } },
          });
        }
      } finally {
        resume.resolve();
      }
      const response = await oldRead;
      const body = await response.text();
      expect(body).not.toContain(secret);
      expect(response.status).toBe(409);
      expect(JSON.parse(body)).toMatchObject({
        code: "session_incarnation_changed",
      });
    },
  );

  it("preserves same-incarnation recovery, missing-session and owner responses", async () => {
    expect(await (await status()).json()).toEqual({ state: "idle" });
    await seedRetry("synthetic-owner-input");
    const normal = await status();
    expect(normal.status).toBe(200);
    expect(await normal.json()).toMatchObject({
      state: "interrupted",
      retry: {
        type: "send_message",
        payload: { content: "synthetic-owner-input" },
      },
    });
    const denied = await status("synthetic-wrong-owner");
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({
      code: "session_owner_required",
    });
    const missing = await status(ownerToken, "missing-session");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Session not found" });
  });

  it.each([false, true])(
    "polls before a long action releases its lock (local active turn: %s)",
    async (active) => {
      const entered = gate();
      const finish = gate();
      let finished = false;
      const action = lock.withLock(sessionId, async () => {
        entered.resolve();
        await finish.promise;
        finished = true;
      });
      await entered.promise;
      const turn = active
        ? registerActiveTurn(sessionId, "active-turn", "active-request")
        : undefined;
      let response: Response | undefined;
      const polling = status().then((value) => {
        response = value;
      });
      try {
        // The timer is only a deadlock watchdog; ordering is asserted while
        // the action's explicit completion gate remains closed.
        await expect.poll(() => response, { timeout: 1_000 }).toBeDefined();
        expect(finished).toBe(false);
        expect(response!.status).toBe(200);
        expect(await response!.json()).toMatchObject({
          state: "running",
          ...(active
            ? { turnId: "active-turn", requestId: "active-request" }
            : {}),
        });
      } finally {
        finish.resolve();
        await action;
        turn?.release();
        await polling;
      }
    },
  );
});
