import { Hono } from "hono";
import { createPluginRegistry } from "@covel/plugin-loader";
import { createRpcApprovalGate } from "@covel/approval";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { sessionRoutes } from "../../src/routes/api/session.js";
import * as worldDataImport from "../../src/world-data/session-import.js";
import { syncWorldDataForSession } from "../../src/world-data/session-import.js";
import { SAFE_SESSION_ID_RE } from "../../src/lib/validators.js";
import { applyPreparedWorldDataImportForSession } from "../../src/world-data/session-import.js";
import { expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryMediaStore,
  createMemoryStore,
  createSqliteMediaStore,
} from "@covel/store";
import { writeImportPlan } from "../../src/world-data/session-import/writes.js";
import {
  materializeMediaIndexWrites,
  finalizeWorldDataMediaRefs,
  releaseWorldDataMediaRefs,
} from "../../src/world-data/session-import/media-handling.js";
import type { PlannedWrite } from "../../src/world-data/session-import/types.js";

it.each(["memory", "sqlite"] as const)(
  "%s keeps concurrently claimed media when another prepared import fails",
  async (backend) => {
    const root = await mkdtemp(join(tmpdir(), "covel-media-compensation-"));
    const mediaStore =
      backend === "memory"
        ? createMemoryMediaStore()
        : createSqliteMediaStore(join(root, "store.db"), {
            mediaRoot: join(root, "media"),
          });
    const store = createMemoryStore();
    try {
      const file = join(root, "shared.png");
      await writeFile(file, new Uint8Array([1, 2, 3]));
      const writes: PlannedWrite[] = [
        {
          kind: "media-index",
          target: "plugin-data:portraits:assets",
          sourceDigest: "digest",
          pluginId: "portraits",
          namespace: "assets",
          key: "hero",
          value: { import: { path: file } },
          source: {
            id: "portraits",
            descriptor: {
              kind: "media",
              path: file,
              to: "media",
              key: "filename",
            },
            order: 0,
            resolvedOrder: 0,
            origin: "world",
            overridden: false,
            pathOrigin: { descriptorRoot: root, origin: "world" },
          },
        },
      ];
      let sharedId = "";
      vi.spyOn(store, "setPluginDataBatch").mockImplementation(async () => {
        // A has materialized its bytes. B now claims the same content before
        // A's semantic write fails and unwinds the actual importer.
        const other = await materializeMediaIndexWrites({
          mediaStore,
          sessionId: "b",
          writes,
        });
        await finalizeWorldDataMediaRefs({ mediaStore, refs: other.mediaRefs });
        sharedId = other.mediaRefs[0]!.id;
        throw new Error("synthetic persistence failure");
      });
      for (const sessionId of ["a", "b"]) {
        await expect(
          writeImportPlan({
            store,
            mediaStore,
            sessionId,
            worldId: "world",
            now: "2026-01-01T00:00:00.000Z",
            plan: {
              writes,
              diagnostics: [],
              mergeEvents: [],
              deferredProjectionOutputs: [],
            },
          }),
        ).rejects.toThrow("synthetic persistence failure");
        expect(await mediaStore.exists(sharedId)).toBe(true);
        expect(await mediaStore.isReferencedBy(sharedId, "b")).toBe(true);
        expect(await mediaStore.listRefs()).toEqual([
          expect.objectContaining({ sessionId: "b", mediaId: sharedId }),
        ]);
        // Even a stale unprotected GC inventory must honor B's current claim.
        await mediaStore.cleanup(new Set(), { maxAgeMs: 0 });
        expect(await mediaStore.exists(sharedId)).toBe(true);
      }
    } finally {
      await store.close();
      await mediaStore.close?.();
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function publicationFixture(backend: "memory" | "sqlite") {
  const root = await mkdtemp(join(tmpdir(), "covel-media-publication-"));
  const mediaStore =
    backend === "memory"
      ? createMemoryMediaStore()
      : createSqliteMediaStore(join(root, "store.db"), {
          mediaRoot: join(root, "media"),
        });
  const file = join(root, "portrait.png");
  await writeFile(file, new Uint8Array([4, 5, 6]));
  const write: PlannedWrite = {
    kind: "media-index",
    target: "plugin-data:portraits:assets",
    sourceDigest: "digest",
    pluginId: "portraits",
    namespace: "assets",
    key: "hero",
    value: { import: { path: file } },
    source: {
      id: "portraits",
      descriptor: { kind: "media", path: file, to: "media", key: "filename" },
      order: 0,
      resolvedOrder: 0,
      origin: "world",
      overridden: false,
      pathOrigin: { descriptorRoot: root, origin: "world" },
    },
  };
  return {
    root,
    mediaStore,
    write,
    close: async () => {
      await mediaStore.close?.();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it.each(["memory", "sqlite"] as const)(
  "%s protects a prepared import from cleanup until semantic publication completes",
  async (backend) => {
    const { mediaStore, write, close } = await publicationFixture(backend);
    const store = createMemoryStore();
    try {
      // Reuse an orphan as well as verify its first creation remains unchanged.
      const old = await mediaStore.put(new Uint8Array([4, 5, 6]), "image/png");
      const createdAt = (await mediaStore.listAssets())[0]!.createdAt;
      const prepared = await materializeMediaIndexWrites({
        mediaStore,
        sessionId: "session",
        writes: [write],
      });
      expect(prepared.mediaRefs[0]?.id).toBe(old.id);
      expect((await mediaStore.listAssets())[0]?.createdAt).toBe(createdAt);
      expect(
        SAFE_SESSION_ID_RE.test(prepared.mediaRefs[0]!.temporarySessionId),
      ).toBe(false);
      const policy = {
        maxAgeMs: 60_000,
        now: new Date(Date.parse(createdAt) + 120_000),
      };
      for (const dryRun of [true, false]) {
        const result = await mediaStore.cleanup(new Set(), {
          ...policy,
          dryRun,
        });
        expect(result.deleted).toBe(0);
        expect(result.protectedIds).toContain(old.id);
      }
      await store.createSession({
        id: "session",
        status: "active",
        phase: "playing",
        setupRuntimes: {},
        locale: "en",
        completedPlayerTurns: 0,
        activePlugins: [],
        createdAt,
        updatedAt: createdAt,
      });
      await store.withTransaction((tx) =>
        applyPreparedWorldDataImportForSession({
          store: tx,
          mediaStore,
          sessionId: "session",
          worldId: "world",
          now: createdAt,
          prepared: {
            imported: true,
            diagnostics: [],
            mediaRefs: prepared.mediaRefs,
            plan: {
              writes: prepared.writes,
              diagnostics: [],
              mergeEvents: [],
              deferredProjectionOutputs: [],
            },
          },
        }),
      );
      expect(
        (await store.getPluginData("session", "portraits", "assets", "hero"))
          ?.value,
      ).toMatchObject({ ref: { id: old.id } });
      expect(await mediaStore.listRefs()).toEqual([
        expect.objectContaining({ sessionId: "session", mediaId: old.id }),
      ]);
      expect(await mediaStore.exists(old.id)).toBe(true);
    } finally {
      await store.close();
      await close();
    }
  },
);

it.each(["memory", "sqlite"] as const)(
  "%s releases only the failed preparation's claims when a later file is missing",
  async (backend) => {
    const { root, mediaStore, write, close } =
      await publicationFixture(backend);
    try {
      const asset = await mediaStore.put(
        new Uint8Array([4, 5, 6]),
        "image/png",
      );
      await mediaStore.recordOwnership(asset.id, "existing");
      await mediaStore.addRef(asset.id, "existing");
      await expect(
        materializeMediaIndexWrites({
          mediaStore,
          sessionId: "existing",
          writes: [
            write,
            {
              ...write,
              value: { import: { path: join(root, "missing.png") } },
            },
          ],
        }),
      ).rejects.toThrow();
      expect(await mediaStore.listRefs()).toEqual([
        expect.objectContaining({ sessionId: "existing", mediaId: asset.id }),
      ]);
      expect((await mediaStore.lookup(asset.id))?.ownerSessionId).toBe(
        "existing",
      );
    } finally {
      await close();
    }
  },
);

it.each(["memory", "sqlite"] as const)(
  "%s isolates concurrent preparation claims for the same session and bytes",
  async (backend) => {
    const { mediaStore, write, close } = await publicationFixture(backend);
    try {
      const first = await materializeMediaIndexWrites({
        mediaStore,
        sessionId: "session",
        writes: [write],
      });
      const second = await materializeMediaIndexWrites({
        mediaStore,
        sessionId: "session",
        writes: [write],
      });
      expect(first.mediaRefs[0]!.temporarySessionId).not.toBe(
        second.mediaRefs[0]!.temporarySessionId,
      );
      await releaseWorldDataMediaRefs({ mediaStore, refs: first.mediaRefs });
      expect(
        (await mediaStore.cleanup(new Set(), { maxAgeMs: 0 })).deleted,
      ).toBe(0);
      expect(await mediaStore.listRefs()).toEqual([
        expect.objectContaining({
          sessionId: second.mediaRefs[0]!.temporarySessionId,
        }),
      ]);
      await releaseWorldDataMediaRefs({ mediaStore, refs: second.mediaRefs });
      expect(
        (await mediaStore.cleanup(new Set(), { maxAgeMs: 0 })).deleted,
      ).toBe(1);
    } finally {
      await close();
    }
  },
);

it("retains a failed temporary release without hiding the import outcome", async () => {
  const { mediaStore, write, close } = await publicationFixture("memory");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const prepared = await materializeMediaIndexWrites({
      mediaStore,
      sessionId: "session",
      writes: [write],
    });
    vi.spyOn(mediaStore, "removeRef").mockRejectedValue(
      new Error("synthetic cleanup failure"),
    );
    await expect(
      finalizeWorldDataMediaRefs({ mediaStore, refs: prepared.mediaRefs }),
    ).resolves.toBeUndefined();
    expect(
      await mediaStore.isReferencedBy(prepared.mediaRefs[0]!.id, "session"),
    ).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "[world-data] failed to release a temporary media reference",
    );
  } finally {
    warn.mockRestore();
    await close();
  }
});

it.each(["memory", "sqlite"] as const)(
  "%s keeps committed sync rows pinned when media finalization fails",
  async (backend) => {
    const { mediaStore, write, close } = await publicationFixture(backend);
    const store = createMemoryStore();
    try {
      const now = new Date().toISOString();
      await store.createSession({
        id: "session",
        status: "active",
        phase: "playing",
        setupRuntimes: {},
        locale: "en",
        completedPlayerTurns: 0,
        activePlugins: [],
        createdAt: now,
        updatedAt: now,
      });
      vi.spyOn(mediaStore, "recordOwnership").mockRejectedValue(
        new Error("synthetic claim failure"),
      );
      await expect(
        syncWorldDataForSession({
          store,
          mediaStore,
          sessionId: "session",
          worldId: "world",
          now,
          prepared: {
            imported: true,
            diagnostics: [],
            plan: {
              writes: [write],
              diagnostics: [],
              mergeEvents: [],
              deferredProjectionOutputs: [],
            },
          },
        }),
      ).rejects.toThrow("synthetic claim failure");
      expect(
        await store.getPluginData("session", "portraits", "assets", "hero"),
      ).not.toBeNull();
      expect(await mediaStore.listRefs()).toHaveLength(1);
      expect((await mediaStore.listRefs())[0]!.sessionId).toMatch(
        /^world-data-import:/,
      );
      expect(
        (await mediaStore.cleanup(new Set(), { maxAgeMs: 0 })).deleted,
      ).toBe(0);
    } finally {
      await store.close();
      await close();
    }
  },
);

it.each([
  "duplicate",
  "world-removed",
  "finalize-failed",
  "rollback-failed",
] as const)(
  "session creation handles preparation references after %s",
  async (failure) => {
    const { mediaStore, write, close } = await publicationFixture("memory");
    const store = createMemoryStore();
    const registry = createPluginRegistry();
    const lock = createInProcessSessionLock();
    const gate = createRpcApprovalGate();
    const now = new Date().toISOString();
    const session = {
      id: "session",
      status: "active",
      phase: "playing",
      setupRuntimes: {},
      locale: "en",
      completedPlayerTurns: 0,
      activePlugins: [],
      createdAt: now,
      updatedAt: now,
    } as const;
    await store.createWorld({
      id: "world",
      name: "World",
      description: "",
      createdAt: now,
    });
    if (failure === "duplicate") {
      await store.createSession(session);
      const asset = await mediaStore.put(
        new Uint8Array([4, 5, 6]),
        "image/png",
      );
      await mediaStore.recordOwnership(asset.id, "session");
      await mediaStore.addRef(asset.id, "session");
    }
    const prepare = vi
      .spyOn(worldDataImport, "prepareWorldDataImportForSession")
      .mockImplementation(async () => {
        const materialized = await materializeMediaIndexWrites({
          mediaStore,
          sessionId: "session",
          writes: [write],
        });
        if (failure === "world-removed") await store.deleteWorld("world");
        return {
          imported: true,
          diagnostics: [],
          mediaRefs: materialized.mediaRefs,
          plan: {
            writes: materialized.writes,
            diagnostics: [],
            mergeEvents: [],
            deferredProjectionOutputs: [],
          },
        };
      });
    if (failure === "finalize-failed" || failure === "rollback-failed") {
      vi.spyOn(mediaStore, "recordOwnership").mockRejectedValue(
        new Error("synthetic claim failure"),
      );
    }
    if (failure === "rollback-failed") {
      vi.spyOn(store, "deleteSession").mockRejectedValue(
        new Error("synthetic rollback failure"),
      );
    }
    const app = new Hono();
    app.onError(() => new Response("synthetic failure", { status: 500 }));
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("mediaStore", mediaStore);
      c.set("pluginRegistry", registry);
      c.set("sessionLock", lock);
      c.set("rpcApprovalGate", gate);
      await next();
    });
    app.route("/api/sessions", sessionRoutes);
    try {
      const response = await app.request("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "session", worldId: "world", plugins: [] }),
      });
      expect(response.status).toBe(
        failure === "duplicate" ? 409 : failure === "world-removed" ? 404 : 500,
      );
      expect(prepare).toHaveBeenCalledOnce();
      const refs = await mediaStore.listRefs();
      if (failure === "duplicate") {
        expect(refs).toEqual([
          expect.objectContaining({ sessionId: "session" }),
        ]);
        expect((await mediaStore.listAssets())[0]!.ownerSessionId).toBe(
          "session",
        );
      } else if (failure === "rollback-failed") {
        expect(await store.getSession("session")).not.toBeNull();
        expect(refs).toHaveLength(1);
        expect(refs[0]!.sessionId).toMatch(/^world-data-import:/);
        expect(
          (await mediaStore.cleanup(new Set(), { maxAgeMs: 0 })).deleted,
        ).toBe(0);
      } else {
        expect(refs).toEqual([]);
        expect(await store.getSession("session")).toBeNull();
        expect(
          (await mediaStore.cleanup(new Set(), { maxAgeMs: 0 })).deleted,
        ).toBe(1);
      }
    } finally {
      prepare.mockRestore();
      await store.close();
      await close();
    }
  },
);
