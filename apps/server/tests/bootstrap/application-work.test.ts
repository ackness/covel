import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { createApplicationWork } from "../../src/application-work.js";
import { createServerResourceDrain } from "../../src/server-resources.js";
import { emitSeq, seedSession } from "../api/sse-test-utils.js";

let pluginsDir: string;
let api: ApiBootstrapResult | undefined;
beforeEach(async () => {
  pluginsDir = await mkdtemp(path.join(tmpdir(), "covel-request-owner-"));
});
afterEach(async () => {
  if (api)
    await createServerResourceDrain({
      api,
      store: api.store,
      worldWatchers: [],
    })();
  api = undefined;
  vi.restoreAllMocks();
  await rm(pluginsDir, { recursive: true, force: true });
});

describe("production API request ownership", () => {
  it("shares the root owner across mounted API and non-API routes", async () => {
    const applicationWork = createApplicationWork();
    api = await bootstrapApi({
      pluginsDir,
      store: createMemoryStore(),
      storeBackend: "memory",
      llmAdapter: { generate: vi.fn() },
      applicationWork,
    });
    const root = new Hono();
    root.use("*", applicationWork.middleware);
    root.route("/", api.app);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    root.get("/host", async (c) => {
      entered.resolve();
      await release.promise;
      return c.text("done");
    });
    expect((await root.request("/api/health")).status).toBe(200);
    const request = root.request("/host");
    await entered.promise;
    const closeStore = vi.spyOn(api.store, "close");
    const closing = createServerResourceDrain({
      api,
      store: api.store,
      worldWatchers: [],
    })();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closeStore).not.toHaveBeenCalled();
      expect((await root.request("/api/health")).status).toBe(503);
      expect((await root.request("/host")).status).toBe(503);
    } finally {
      release.resolve();
      await request;
      await closing;
    }
    expect(closeStore).toHaveBeenCalledOnce();
  });

  it("drains an active subscription read after stream abort before closing its store", async () => {
    const store = createMemoryStore();
    await seedSession(store, "session");
    api = await bootstrapApi({
      pluginsDir,
      store,
      storeBackend: "memory",
      llmAdapter: { generate: vi.fn() },
    });
    const response = await api.app.request(
      "/api/events/stream?sessionId=session",
    );
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "system.connected",
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const getSession = store.getSession.bind(store);
    vi.spyOn(store, "getSession").mockImplementationOnce(async (id) => {
      entered.resolve();
      await release.promise;
      return getSession(id);
    });
    emitSeq(api.eventBus, "session", "state", 1);
    await entered.promise;
    const closeStore = vi.spyOn(store, "close");
    const closeBus = vi.spyOn(api.eventBus, "close");
    const closing = createServerResourceDrain({
      api,
      store,
      worldWatchers: [],
    })();
    try {
      await reader.cancel();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closeStore).not.toHaveBeenCalled();
      expect(closeBus).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await closing;
    }
    expect(closeStore).toHaveBeenCalledOnce();
    expect(closeBus).toHaveBeenCalledOnce();
  });
});
