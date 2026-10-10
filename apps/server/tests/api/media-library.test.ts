/**
 * The player's media library: `GET /api/media/library` and
 * `POST /api/media/library/delete`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { MediaRef } from "@covel/shared";
import type { DataStore, MediaStore } from "@covel/store";
import { createMemoryMediaStore, createMemoryStore } from "@covel/store/memory";
import { mediaRoutes } from "../../src/routes/api/media.js";
import {
  makeMessage,
  makeRuntimeOutput,
  makeSession,
  makeSnapshot,
  makeSnapshotPayload,
  makeTraceEvent,
  makeTurnResult,
  ts,
} from "../../../../packages/store/src/contract/test-fixtures.js";

interface LibraryItem {
  readonly id: string;
  readonly kind: string;
  readonly size: number;
  readonly usage: string;
  readonly usedBy: readonly string[];
  readonly url: string;
  readonly name?: string;
}

interface LibraryListing {
  readonly items: readonly LibraryItem[];
  readonly total: number;
  readonly sessions: readonly { id: string; worldId?: string }[];
  readonly totals: {
    count: number;
    bytes: number;
    unusedCount: number;
    unusedBytes: number;
    byKind: Record<string, { count: number; unusedCount: number }>;
  };
  readonly scan: { complete: boolean; incompleteSessionId?: string };
}

interface DeleteResult {
  readonly deletedIds: readonly string[];
  readonly bytesDeleted: number;
  readonly skipped: readonly { id: string; reason: string }[];
}

function createTestApp(
  mediaStore: MediaStore,
  dataStore: DataStore,
  storeBackend = "sqlite",
): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", dataStore);
    c.set("mediaStore", mediaStore);
    c.set("storeBackend", storeBackend as never);
    await next();
  });
  app.route("/api/media", mediaRoutes);
  return app;
}

async function list(app: Hono, query = ""): Promise<LibraryListing> {
  // `refresh` keeps each assertion on a scan of its own.
  const res = await app.request(
    `/api/media/library?refresh=1${query ? `&${query}` : ""}`,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as LibraryListing;
}

function postDelete(app: Hono, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request("/api/media/library/delete", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

let seed = 0;
function put(mediaStore: MediaStore, mime: string, meta?: object) {
  seed += 1;
  return mediaStore.put(new Uint8Array([seed, seed, seed, seed]), mime, meta);
}

/** One way a session can name an asset in the rows the scan reads. */
const CONTENT_REFERENCES: Readonly<
  Record<
    string,
    (store: DataStore, sessionId: string, ref: MediaRef) => Promise<void>
  >
> = {
  messages: (store, sessionId, ref) =>
    store.addMessage(makeMessage({ sessionId, metadata: { image: ref } })),
  plugin_data: (store, sessionId, ref) =>
    store.setPluginData({
      id: `pd-${ref.id}`,
      sessionId,
      pluginId: "scene",
      namespace: "media",
      key: "background",
      value: { ref },
      createdAt: ts(),
      updatedAt: ts(),
    }),
  runtime_outputs: (store, sessionId, ref) =>
    store.saveRuntimeOutput(
      makeRuntimeOutput({ sessionId, results: [{ structured: { ref } }] }),
    ),
  trace_events: (store, sessionId, ref) =>
    store.addTraceEvent(
      makeTraceEvent({ sessionId, payload: { output: { images: [ref] } } }),
    ),
  snapshots: (store, sessionId, ref) =>
    store.saveSnapshot(
      makeSnapshot({
        sessionId,
        payload: makeSnapshotPayload({
          pluginData: [
            {
              id: "snap-pd",
              sessionId,
              pluginId: "scene",
              namespace: "media",
              key: "background",
              value: { ref },
              createdAt: ts(),
              updatedAt: ts(),
            },
          ],
        }),
      }),
    ),
  turn_results: (store, sessionId, ref) =>
    store.saveTurnResult(
      makeTurnResult({
        sessionId,
        runtimeResults: [{ output: { value: { portrait: ref } } }],
      }),
    ),
};

const ORIGINAL_ENV = {
  DEPLOYMENT_TIER: process.env.DEPLOYMENT_TIER,
  NODE_ENV: process.env.NODE_ENV,
  COVEL_DESKTOP_REST_TOKEN: process.env.COVEL_DESKTOP_REST_TOKEN,
};

describe("media library", () => {
  let dataStore: DataStore;
  let mediaStore: MediaStore;
  let app: Hono;

  beforeEach(() => {
    delete process.env.DEPLOYMENT_TIER;
    delete process.env.COVEL_DESKTOP_REST_TOKEN;
    dataStore = createMemoryStore();
    mediaStore = createMemoryMediaStore();
    app = createTestApp(mediaStore, dataStore);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("lists stored media with usage, sessions and totals", async () => {
    await dataStore.createSession(
      makeSession({ id: "sess-A", worldId: "world-A" }),
    );
    const used = await put(mediaStore, "image/png", { filename: "gate.png" });
    await mediaStore.recordOwnership(used.id, "sess-A");
    const unusedAudio = await put(mediaStore, "audio/mpeg");
    const unusedVideo = await put(mediaStore, "video/mp4");

    const all = await list(app);
    expect(all.total).toBe(3);
    expect(all.totals).toMatchObject({
      count: 3,
      bytes: 12,
      unusedCount: 2,
      unusedBytes: 8,
    });
    expect(all.totals.byKind.image).toMatchObject({ count: 1, unusedCount: 0 });
    expect(all.scan.complete).toBe(true);
    const usedItem = all.items.find((item) => item.id === used.id);
    expect(usedItem).toMatchObject({
      kind: "image",
      usage: "used",
      usedBy: ["sess-A"],
      name: "gate.png",
    });
    expect(all.sessions).toEqual([
      expect.objectContaining({ id: "sess-A", worldId: "world-A" }),
    ]);

    const audio = await list(app, "kind=audio");
    expect(audio.items.map((item) => item.id)).toEqual([unusedAudio.id]);
    expect(audio.total).toBe(1);
    // Totals describe the whole library, not the filtered page.
    expect(audio.totals.count).toBe(3);

    const unused = await list(app, "usage=unused");
    expect(new Set(unused.items.map((item) => item.id))).toEqual(
      new Set([unusedAudio.id, unusedVideo.id]),
    );

    const paged = await list(app, "limit=2&offset=2");
    expect(paged.items).toHaveLength(1);
    expect(paged.total).toBe(3);
  });

  it("serves bytes through the listing URL, also for media no session uses", async () => {
    const unused = await put(mediaStore, "image/png");
    const [item] = (await list(app)).items;
    const res = await app.request(item!.url);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBe(
      unused.size,
    );
  });

  for (const [place, write] of Object.entries(CONTENT_REFERENCES)) {
    it(`keeps media that a session names only in ${place}`, async () => {
      await dataStore.createSession(makeSession({ id: "sess-A" }));
      const named = await put(mediaStore, "image/png");
      const unused = await put(mediaStore, "image/png");
      await write(dataStore, "sess-A", named);

      const listing = await list(app);
      expect(listing.items.find((item) => item.id === named.id)).toMatchObject({
        usage: "used",
        usedBy: ["sess-A"],
      });
      expect(listing.totals.unusedCount).toBe(1);

      const all = await postDelete(app, { unused: true });
      expect(all.status).toBe(200);
      expect(((await all.json()) as DeleteResult).deletedIds).toEqual([
        unused.id,
      ]);

      const chosen = await postDelete(app, { ids: [named.id] });
      expect((await chosen.json()) as DeleteResult).toEqual({
        deletedIds: [],
        bytesDeleted: 0,
        skipped: [{ id: named.id, reason: "in_use" }],
      });
      expect(await mediaStore.exists(named.id)).toBe(true);
    });
  }

  it("keeps world media that another session of the same world still references", async () => {
    await dataStore.createSession(makeSession({ id: "sess-A" }));
    await dataStore.createSession(makeSession({ id: "sess-B" }));
    const shared = await put(mediaStore, "image/webp");
    // The import of each session claims the same content-addressed bytes.
    for (const sessionId of ["sess-A", "sess-B"]) {
      await mediaStore.recordOwnership(shared.id, sessionId, "scene");
      await mediaStore.addRef(shared.id, sessionId, "scene");
    }

    // Deleting the first session releases its claims only.
    await mediaStore.releaseSession("sess-A");
    await dataStore.deleteSession("sess-A");
    expect((await list(app)).items[0]).toMatchObject({
      usage: "used",
      usedBy: ["sess-B"],
    });

    await mediaStore.releaseSession("sess-B");
    await dataStore.deleteSession("sess-B");
    expect((await list(app)).items[0]).toMatchObject({
      usage: "unused",
      usedBy: [],
    });
  });

  it("does not call media unused while something that is not a session claims it", async () => {
    const pinned = await put(mediaStore, "image/png");
    await mediaStore.addRef(pinned.id, "world-data-import:attempt");

    const listing = await list(app);
    expect(listing.items[0]).toMatchObject({ usage: "held", usedBy: [] });
    expect(listing.totals.unusedCount).toBe(0);

    const res = await postDelete(app, { unused: true });
    expect(((await res.json()) as DeleteResult).deletedIds).toEqual([]);
    expect(await mediaStore.exists(pinned.id)).toBe(true);
  });

  it("deletes the chosen unused media and reports the rest", async () => {
    await dataStore.createSession(makeSession({ id: "sess-A" }));
    const chosen = await put(mediaStore, "image/png");
    const notChosen = await put(mediaStore, "image/png");
    const used = await put(mediaStore, "audio/wav");
    await mediaStore.addRef(used.id, "sess-A");

    const res = await postDelete(app, {
      ids: [chosen.id, used.id, "f".repeat(64)],
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as DeleteResult).toEqual({
      deletedIds: [chosen.id],
      bytesDeleted: chosen.size,
      skipped: [
        { id: used.id, reason: "in_use" },
        { id: "f".repeat(64), reason: "not_found" },
      ],
    });
    expect(await mediaStore.exists(chosen.id)).toBe(false);
    expect(await mediaStore.exists(notChosen.id)).toBe(true);
    expect(await mediaStore.exists(used.id)).toBe(true);
  });

  it("keeps media that a session claimed between the scan and the deletion", async () => {
    await dataStore.createSession(makeSession({ id: "sess-A" }));
    const asset = await put(mediaStore, "image/png");
    const cleanup = mediaStore.cleanup.bind(mediaStore);
    mediaStore.cleanup = async (protectedIds, policy) => {
      await mediaStore.addRef(asset.id, "sess-A");
      return cleanup(protectedIds, policy);
    };

    const res = await postDelete(app, { ids: [asset.id] });
    expect((await res.json()) as DeleteResult).toEqual({
      deletedIds: [],
      bytesDeleted: 0,
      skipped: [{ id: asset.id, reason: "in_use" }],
    });
    expect(await mediaStore.exists(asset.id)).toBe(true);
  });

  it("deletes media a session uses only one at a time and only with force", async () => {
    await dataStore.createSession(makeSession({ id: "sess-A" }));
    const first = await put(mediaStore, "image/png");
    const second = await put(mediaStore, "image/png");
    await mediaStore.recordOwnership(first.id, "sess-A");
    await mediaStore.recordOwnership(second.id, "sess-A");

    const many = await postDelete(app, {
      ids: [first.id, second.id],
      force: true,
    });
    expect(many.status).toBe(400);
    const all = await postDelete(app, { unused: true, force: true });
    expect(all.status).toBe(400);
    expect(await mediaStore.exists(first.id)).toBe(true);

    const one = await postDelete(app, { ids: [first.id], force: true });
    expect((await one.json()) as DeleteResult).toEqual({
      deletedIds: [first.id],
      bytesDeleted: first.size,
      skipped: [],
    });
    expect(await mediaStore.exists(first.id)).toBe(false);
    expect(await mediaStore.isReferencedBy(first.id, "sess-A")).toBe(false);
    expect(await mediaStore.exists(second.id)).toBe(true);
  });

  it("marks nothing unused and refuses to delete when a session cannot be read to the end", async () => {
    await dataStore.createSession(makeSession({ id: "sess-big" }));
    for (let i = 0; i < 5; i += 1) {
      await dataStore.addMessage(makeMessage({ sessionId: "sess-big" }));
    }
    const asset = await put(mediaStore, "image/png");

    const listing = await list(app, "scanLimit=2");
    expect(listing.scan).toMatchObject({
      complete: false,
      incompleteSessionId: "sess-big",
    });
    expect(listing.items[0]).toMatchObject({ usage: "unknown" });
    expect(listing.totals.unusedCount).toBe(0);
    expect((await list(app, "scanLimit=2&usage=unused")).items).toEqual([]);

    for (const body of [
      { unused: true, scanLimit: 2 },
      { ids: [asset.id], scanLimit: 2 },
    ]) {
      const res = await postDelete(app, body);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "scan_incomplete" });
    }
    expect(await mediaStore.exists(asset.id)).toBe(true);
  });

  it("answers page requests from one scan until a refresh or a deletion", async () => {
    await dataStore.createSession(makeSession({ id: "sess-A" }));
    await put(mediaStore, "image/png");
    let scans = 0;
    const listSessions = dataStore.listSessions.bind(dataStore);
    dataStore.listSessions = async (...args) => {
      scans += 1;
      return listSessions(...args);
    };

    await app.request("/api/media/library?refresh=1");
    await app.request("/api/media/library?offset=1");
    await app.request("/api/media/library?kind=audio");
    expect(scans).toBe(1);

    await postDelete(app, { unused: true });
    expect(scans).toBe(2);
    const after = await app.request("/api/media/library");
    expect(scans).toBe(3);
    expect(((await after.json()) as LibraryListing).totals.count).toBe(0);
  });

  it("rejects malformed requests", async () => {
    for (const query of ["kind=text", "usage=all", "limit=0", "offset=-1"]) {
      const res = await app.request(`/api/media/library?${query}`);
      expect(res.status, query).toBe(400);
    }
    for (const body of [{}, { ids: [] }, { ids: ["a"], unused: true }, []]) {
      const res = await postDelete(app, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("is unavailable where the server stores media of several owners", async () => {
    const asset = await put(mediaStore, "image/png");
    const { url } = (await list(app)).items[0]!;

    for (const tier of ["demo", "commercial"]) {
      process.env.DEPLOYMENT_TIER = tier;
      // Not even the operator: there is no per-owner media index to show.
      process.env.COVEL_DESKTOP_REST_TOKEN = "operator-secret";
      const headers = { authorization: "Bearer operator-secret" };
      const listing = await app.request("/api/media/library", { headers });
      expect(listing.status, tier).toBe(503);
      expect(await listing.json()).toMatchObject({ code: "unavailable" });
      const deletion = await app.request("/api/media/library/delete", {
        method: "POST",
        body: JSON.stringify({ ids: [asset.id], force: true }),
        headers: { ...headers, "content-type": "application/json" },
      });
      expect(deletion.status, tier).toBe(503);
      // A listing URL issued earlier stops working as well.
      expect((await app.request(url)).status, tier).toBe(403);
    }
    expect(await mediaStore.exists(asset.id)).toBe(true);

    // The browser-private profile: a production server on the memory store.
    delete process.env.DEPLOYMENT_TIER;
    process.env.NODE_ENV = "production";
    const browserPrivate = createTestApp(mediaStore, dataStore, "memory");
    expect((await browserPrivate.request("/api/media/library")).status).toBe(
      503,
    );
  });
});
