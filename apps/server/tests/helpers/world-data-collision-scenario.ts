import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import type { DataStore } from "@covel/store";
import { createMemoryMediaStore } from "@covel/store/memory";
import { datasetWriteFixture } from "./dataset-write-fixture.js";
import { importWorldDataForSession } from "./world-data-import.js";

export const COLLISION_CASES = [
  "path",
  "visibility",
  "directory",
  "media",
  "character",
] as const;

/** Stored content must survive a new, inactive and unapproved static claim. */
export async function worldDataCollisionScenario(
  store: DataStore,
  kind: (typeof COLLISION_CASES)[number],
) {
  const f = await datasetWriteFixture();
  const mediaStore = createMemoryMediaStore();
  try {
    const original = f.registry.get("probe")!;
    const declaration =
      original.packageManifest!.plugin.contributes!.data!.notes!;
    let sourcePath = "data/notes.json";
    if (kind === "directory") sourcePath = "data/notes/*.json";
    if (kind === "media") sourcePath = "media/notes";
    if (kind === "character") {
      await rm(path.join(f.worldRoot, "data/notes.json"));
      await writeFile(
        path.join(f.worldRoot, "characters/characters.json"),
        JSON.stringify([
          {
            id: "hero",
            name: "Hero",
            type: "npc",
            notes: { id: "hero", text: "before" },
          },
        ]),
      );
    } else if (kind === "directory" || kind === "media") {
      await rm(path.join(f.worldRoot, "data/notes.json"));
      await mkdir(path.join(f.worldRoot, path.posix.dirname(sourcePath)), {
        recursive: true,
      });
      if (kind === "directory") {
        await writeFile(
          path.join(f.worldRoot, "data/notes/first.json"),
          '[{"id":"a","text":"before"}]',
        );
      } else {
        await mkdir(path.join(f.worldRoot, sourcePath));
        await writeFile(
          path.join(f.worldRoot, sourcePath, "portrait.png"),
          new Uint8Array([1, 2, 3]),
        );
        await writeFile(
          path.join(f.pluginRoot, "schemas/notes.json"),
          '{"type":"object"}',
        );
      }
    }
    const data = {
      ...declaration,
      authoring: {
        title: "Notes",
        ...(kind === "character"
          ? { characterField: "notes" }
          : {
              source: {
                path: sourcePath,
                key: kind === "media" ? "filename" : "id",
              },
            }),
      },
    };
    f.registry.register({
      ...original,
      dataSchemas: undefined,
      datasets: undefined,
      packageManifest: {
        ...original.packageManifest!,
        ...(kind === "media"
          ? { datasetSchemas: { notes: { type: "object" } } }
          : {}),
        plugin: {
          ...original.packageManifest!.plugin,
          contributes: { data: { notes: data } },
        },
      },
    });
    await store.createWorld({
      id: f.options.worldId,
      name: "Notes",
      description: "Notes",
      createdAt: f.options.now,
    });
    await store.createSession(f.session());
    await importWorldDataForSession({ store, mediaStore, ...f.options });
    const rows = await f.rows(store);
    const ledgers = await store.listWorldDataImportLedger(f.options.sessionId);
    const refs = await mediaStore.listRefs();
    expect(rows.length).toBeGreaterThan(0);
    expect(ledgers.some((row) => row.pluginId === "probe")).toBe(true);
    if (kind === "media") expect(refs).toHaveLength(1);

    // Sort before the original claimant to also cover its previously bare ID.
    const receiver = f.registry.get("probe")!;
    f.registry.register({
      ...receiver,
      id: "another",
      source: "community",
      dataSchemas: undefined,
      packageManifest: {
        ...receiver.packageManifest!,
        plugin: {
          ...receiver.packageManifest!.plugin,
          id: "another",
          contributes: {
            data: {
              notes: {
                ...data,
                accepts: [
                  kind === "visibility" ? "probe.notes@1" : "other.notes@1",
                ],
                authoring: {
                  ...data.authoring,
                  ...(kind === "visibility"
                    ? { source: { path: sourcePath, visibility: "hidden" } }
                    : {}),
                },
              },
            },
          },
        },
      },
    });
    for (const dryRun of [true, false]) {
      const result = await f.sync(store, { mediaStore, dryRun });
      expect(
        result.diagnostics.some((diagnostic) =>
          diagnostic.message.includes("more than one plugin"),
        ),
      ).toBe(true);
      expect(result.deleted).toBe(0);
      expect(await f.rows(store)).toEqual(rows);
      expect(
        await store.listWorldDataImportLedger(f.options.sessionId),
      ).toEqual(ledgers);
      expect(await mediaStore.listRefs()).toEqual(refs);
    }
    expect(
      await store.listPluginData(f.options.sessionId, "another", "notes"),
    ).toEqual([]);

    // Explicit disambiguation makes the source authoritative again.
    if (kind === "path" || kind === "visibility") {
      await writeFile(
        path.join(f.worldRoot, "world.yaml"),
        "id: dataset-world\nworldData: descriptor.yaml\n",
      );
      await writeFile(
        path.join(f.worldRoot, "descriptor.yaml"),
        "sources:\n  notes:\n    kind: json\n    path: data/notes.json\n    key: id\n    to: contract:probe.notes@1\n",
      );
      await f.records([]);
      expect((await f.sync(store, { mediaStore })).deleted).toBe(2);
      expect(await f.rows(store)).toEqual([]);
    }
  } finally {
    await mediaStore.close?.();
    await f.cleanup();
  }
}
