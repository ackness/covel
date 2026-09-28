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
