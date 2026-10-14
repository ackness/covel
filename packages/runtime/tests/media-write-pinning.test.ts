/**
 * Media writes stay pinned from the moment their bytes are published until
 * the session's claims are recorded (F-164), and a multi-image generation
 * claims its images together or not at all (F-169). Both run against the
 * real in-memory MediaStore so cleanup applies its true deletion gate.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { MediaStore } from "@covel/shared";
import type { PluginRuntimeUtils } from "@covel/plugin-loader";
import type { ResolvedSlotForPlugin } from "@covel/shared/plugin-runtime";
import { createMemoryMediaStore } from "@covel/store/memory";
import { createSqliteMediaStore } from "@covel/store/sqlite";
import {
  createRuntimeMediaContext,
  createRuntimeMediaWriter,
} from "../src/function-runtime/runtime-media-context.js";
import { createRuntimeImagesContext } from "../src/function-runtime/runtime-images-context.js";

const OWNER = { sessionId: "sess-1", pluginId: "img-plugin" } as const;

function png(marker: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    marker,
  ]);
}

/** Serves fixed bodies by URL; a URL without a body answers 500. */
function utilsServing(bodies: Record<string, Uint8Array<ArrayBuffer>>) {
  return {
    validateBaseUrl: () => ({ ok: true }),
    fetchWithRetry: vi.fn(async (input: string | URL) => {
      const body = bodies[input.toString()];
      return body
        ? new Response(body, { headers: { "content-type": "image/png" } })
        : new Response("gone", { status: 500 });
    }),
  } as unknown as PluginRuntimeUtils;
}

/**
 * A media store on which a full cleanup ("delete every unused asset") runs
 * the moment each `put` returns, before the caller can record its claims.
 */
function storeSweptAfterEveryPut(): MediaStore {
  const store = createMemoryMediaStore();
  return {
    ...store,
    async put(...args) {
      const ref = await store.put(...args);
      await store.cleanup(new Set(), { dryRun: false, maxBytes: 0 });
      return ref;
    },
  };
}

describe("pinned media writes (F-164)", () => {
  it("ctx.media.put keeps its bytes through a cleanup that runs before the owner is recorded", async () => {
    const mediaStore = storeSweptAfterEveryPut();
    const media = createRuntimeMediaContext(mediaStore, undefined, OWNER);

    const ref = await media.put(png(1), "image/png");

    expect(await mediaStore.exists(ref.id)).toBe(true);
    expect((await mediaStore.lookup(ref.id))?.ownerSessionId).toBe("sess-1");
    // The temporary pin is gone; only the session's own reference remains.
    expect((await mediaStore.listRefs()).map((row) => row.sessionId)).toEqual([
      "sess-1",
    ]);
    await expect(media.get(ref)).resolves.toBeDefined();
  });

  it("ctx.media.ingestUrl keeps its bytes through the same cleanup", async () => {
    const mediaStore = storeSweptAfterEveryPut();
    const media = createRuntimeMediaContext(
      mediaStore,
      utilsServing({ "https://images.test/a.png": png(2) }),
      OWNER,
    );

    const ref = await media.ingestUrl("https://images.test/a.png");

    expect(await mediaStore.exists(ref.id)).toBe(true);
    expect((await mediaStore.lookup(ref.id))?.ownerSessionId).toBe("sess-1");
    expect((await mediaStore.listRefs()).map((row) => row.sessionId)).toEqual([
      "sess-1",
    ]);
  });

  it("an aborted write releases its pin and claims nothing", async () => {
    const mediaStore = createMemoryMediaStore();
    const controller = new AbortController();
    const media = createRuntimeMediaContext(mediaStore, undefined, {
      ...OWNER,
      signal: controller.signal,
    });
    controller.abort(new Error("runtime timed out"));

    await expect(media.put(png(3), "image/png")).rejects.toThrow(
      "runtime timed out",
    );

    const [asset] = await mediaStore.listAssets();
    expect(asset?.ownerSessionId).toBeNull();
    expect(await mediaStore.listRefs()).toEqual([]);
  });
});

describe("ctx.images.generate stores a batch all or nothing (F-169)", () => {
  function setup(
    bodies: Record<string, Uint8Array<ArrayBuffer>>,
    mediaStore: MediaStore = createMemoryMediaStore(),
  ) {
    const target: ResolvedSlotForPlugin = {
      presetId: "image",
      provider: "test",
      model: "image-model",
      protocol: "openai-chat-v1",
      baseUrl: "https://images.test/v1",
      tag: "image",
      metadata: { imageWire: "openai-images" },
    };
    const gateway = {
      resolveSlot: vi.fn(() => target),
      generateImage: vi.fn(async () => ({
        target,
        images: [
          { kind: "bytes" as const, bytes: png(10), mime: "image/png" },
          {
            kind: "url" as const,
            url: "https://images.test/b.png",
            mime: "image/png",
          },
        ],
        warnings: [],
      })),
    };
    const utils = utilsServing(bodies);
    const images = createRuntimeImagesContext(
      gateway,
      mediaStore,
      createRuntimeMediaWriter(mediaStore, utils, OWNER),
      OWNER,
    );
    return { mediaStore, gateway, images, utils };
  }

  it("leaves no image owned by the session when the second image fails to store", async () => {
    const { mediaStore, images } = setup({});

    await expect(images.generate({ prompt: "two cats", n: 2 })).rejects.toThrow(
      "HTTP 500",
    );

    const assets = await mediaStore.listAssets();
    expect(assets).toHaveLength(1);
    expect(assets[0]?.ownerSessionId).toBeNull();
    expect(await mediaStore.listRefs()).toEqual([]);
    expect(
      await mediaStore.listByMetadata("sess-1", { pluginId: "img-plugin" }),
    ).toEqual([]);
  });

  it.each([
    ["no image had an owner", false],
    ["another session already owns the first image", true],
  ])(
    "claims no image of the batch when recording the second claim fails (%s)",
    async (_, shared) => {
      // A real SQL transaction, failed part-way by a trigger on the second
      // image's ref; the in-memory store cannot fail between two claims.
      const dir = mkdtempSync(path.join(tmpdir(), "covel-claim-batch-"));
      const dbPath = path.join(dir, "media.db");
      const mediaStore = createSqliteMediaStore(dbPath, {
        mediaRoot: path.join(dir, "media"),
      });
      const db = new DatabaseSync(dbPath);
      try {
        const firstId = createHash("sha256").update(png(10)).digest("hex");
        if (shared) {
          await mediaStore.put(png(10), "image/png");
          await mediaStore.claimAssets([
            { id: firstId, sessionId: "sess-other", pluginId: "other-plugin" },
          ]);
        }
        const secondId = createHash("sha256").update(png(11)).digest("hex");
        db.exec(`
        CREATE TRIGGER fail_second_claim
        BEFORE INSERT ON media_refs
        WHEN NEW.media_id = '${secondId}' AND NEW.session_id = 'sess-1'
        BEGIN
          SELECT RAISE(ABORT, 'synthetic claim failure');
        END
      `);
        const { images } = setup(
          { "https://images.test/b.png": png(11) },
          mediaStore,
        );

        await expect(
          images.generate({ prompt: "two cats", n: 2 }),
        ).rejects.toThrow("synthetic claim failure");

        const owners = Object.fromEntries(
          (await mediaStore.listAssets()).map((asset) => [
            asset.id,
            asset.ownerSessionId,
          ]),
        );
        expect(owners).toEqual({
          [firstId]: shared ? "sess-other" : null,
          [secondId]: null,
        });
        expect(
          (await mediaStore.listRefs()).map((row) => [
            row.mediaId,
            row.sessionId,
          ]),
        ).toEqual(shared ? [[firstId, "sess-other"]] : []);
      } finally {
        db.close();
        await mediaStore.close?.();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("claims both images of a successful batch and serves that batch from the cache", async () => {
    const { mediaStore, gateway, images } = setup({
      "https://images.test/b.png": png(11),
    });

    const first = await images.generate({ prompt: "two cats", n: 2 });
    const again = await images.generate({ prompt: "two cats", n: 2 });

    expect(first.refs).toHaveLength(2);
    for (const ref of first.refs)
      expect((await mediaStore.lookup(ref.id))?.ownerSessionId).toBe("sess-1");
    expect(
      (await mediaStore.listRefs()).every((row) => row.sessionId === "sess-1"),
    ).toBe(true);
    expect(again.cached).toBe(true);
    expect(again.refs.map((ref) => ref.id).sort()).toEqual(
      first.refs.map((ref) => ref.id).sort(),
    );
    expect(gateway.generateImage).toHaveBeenCalledTimes(1);
  });
});
