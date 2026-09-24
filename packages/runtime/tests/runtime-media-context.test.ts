import { describe, expect, it, vi } from "vitest";
import type { PluginRuntimeUtils } from "@covel/plugin-loader";
import {
  createRuntimeMediaContext,
  type MediaStoreLike,
} from "../src/function-runtime/runtime-media-context.js";

function pngBytes(extra = 0): Uint8Array {
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return new Uint8Array([...header, ...Array.from({ length: extra }, () => 0)]);
}

interface StoredAsset {
  readonly mime: string;
  readonly size: number;
  ownerSessionId: string | null;
  ownerPluginId: string | null;
}

function createStore(): MediaStoreLike & {
  readonly puts: Array<{
    bytes: Uint8Array | Blob;
    mime: string;
    meta: unknown;
  }>;
  readonly ownerships: Array<{
    id: string;
    sessionId: string;
    pluginId?: string;
  }>;
  readonly refs: Array<{ id: string; sessionId: string; pluginId?: string }>;
  readonly assets: Map<string, StoredAsset>;
} {
  const puts: Array<{ bytes: Uint8Array | Blob; mime: string; meta: unknown }> =
    [];
  const ownerships: Array<{
    id: string;
    sessionId: string;
    pluginId?: string;
  }> = [];
  const refs: Array<{ id: string; sessionId: string; pluginId?: string }> = [];
  const assets = new Map<string, StoredAsset>();
  return {
    puts,
    ownerships,
    refs,
    assets,
    async put(bytes, mime, meta) {
      puts.push({ bytes, mime, meta });
      const size = bytes instanceof Uint8Array ? bytes.byteLength : bytes.size;
      const id = `media-${puts.length}`;
      assets.set(id, { mime, size, ownerSessionId: null, ownerPluginId: null });
      return { id, mime, size };
    },
    async get(ref) {
      return new Uint8Array(ref.size);
    },
    async resolveUrl(ref) {
      return `https://media.example.test/${ref.id}`;
    },
    async recordOwnership(id, sessionId, pluginId) {
      ownerships.push({
        id,
        sessionId,
        ...(pluginId === undefined ? {} : { pluginId }),
      });
      const asset = assets.get(id);
      if (asset && asset.ownerSessionId === null) {
        asset.ownerSessionId = sessionId;
        asset.ownerPluginId = pluginId ?? null;
      }
    },
    async lookup(id) {
      const asset = assets.get(id);
      if (!asset) return null;
      return {
        id,
        mime: asset.mime,
        size: asset.size,
        ownerSessionId: asset.ownerSessionId,
        ownerPluginId: asset.ownerPluginId,
      };
    },
    async addRef(id, sessionId, pluginId) {
      if (!assets.has(id)) return;
      refs.push({
        id,
        sessionId,
        ...(pluginId === undefined ? {} : { pluginId }),
      });
    },
    async isReferencedBy(id, sessionId) {
      const asset = assets.get(id);
      if (asset?.ownerSessionId === sessionId) return true;
      return refs.some((r) => r.id === id && r.sessionId === sessionId);
    },
  };
}

const TEST_OWNER = { sessionId: "sess-test", pluginId: "plugin-test" } as const;

interface RecordedFetch {
  readonly url: string;
  readonly redirect: string | undefined;
}

/**
 * Test double that mirrors the production injection
 * (`@covel/ai-provider` `plugin-utils.fetchWithRetry`): undici is always driven
 * with `redirect: "manual"`, and a 3xx is handed back to the caller ONLY when
 * the caller explicitly asked for `redirect: "manual"`. Otherwise it fails
 * closed with the SSRF error. Keeping the double faithful is what makes the
 * redirect-hop assertions below mean the same thing in CI as in production.
 */
function createUtils(
  responses: Record<string, Response>,
  blockedUrls: readonly string[] = [],
): PluginRuntimeUtils & { readonly calls: RecordedFetch[] } {
  const calls: RecordedFetch[] = [];
  return {
    calls,
    validateBaseUrl(url) {
      return blockedUrls.includes(url)
        ? { ok: false, reason: "blocked by test policy" }
        : { ok: true };
    },
    async fetchWithRetry(input, init) {
      const url = input.toString();
      calls.push({ url, redirect: init?.redirect });
      const response = responses[url];
      if (!response) throw new Error(`unexpected fetch: ${url}`);
      const isRedirect = response.status >= 300 && response.status < 400;
      if (isRedirect && init?.redirect !== "manual") {
        throw new Error(
          `baseUrl rejected by SSRF policy: refusing to follow redirect ` +
            `(HTTP ${response.status}) from "${url}".`,
        );
      }
      return response;
    },
  };
}

describe("createRuntimeMediaContext", () => {
  it("forwards put to the media store and authorises get/resolveUrl for the owner", async () => {
    const store = createStore();
    const media = createRuntimeMediaContext(store, undefined, TEST_OWNER);
    const ref = await media.put(
      new Uint8Array([1, 2, 3]),
      "application/octet-stream",
    );

    expect(ref).toEqual({
      id: "media-1",
      mime: "application/octet-stream",
      size: 3,
    });
    expect(await media.get(ref)).toEqual(new Uint8Array(3));
    // resolveUrl returns an opaque placeholder so plugins cannot bypass
    // the HTTP token gate by handing out backend-native URLs (e.g. file://).
    expect(await media.resolveUrl(ref)).toBe("media:media-1");
    expect(store.ownerships).toEqual([
      {
        id: "media-1",
        sessionId: TEST_OWNER.sessionId,
        pluginId: TEST_OWNER.pluginId,
      },
    ]);
    // put() also takes a ref for the owner so authorisation lookups stay
    // uniform with cross-session fork rows.
    expect(store.refs).toEqual([
      {
        id: "media-1",
        sessionId: TEST_OWNER.sessionId,
        pluginId: TEST_OWNER.pluginId,
      },
    ]);
  });

  it("rejects get/resolveUrl for a session that neither owns nor references the asset", async () => {
    const store = createStore();
    const ownerMedia = createRuntimeMediaContext(store, undefined, TEST_OWNER);
    const ref = await ownerMedia.put(
      new Uint8Array([1, 2, 3]),
      "application/octet-stream",
    );

    const otherMedia = createRuntimeMediaContext(store, undefined, {
      sessionId: "sess-other",
      pluginId: "plugin-other",
    });

    await expect(otherMedia.get(ref)).rejects.toThrow(/not accessible/);
    await expect(otherMedia.resolveUrl(ref)).rejects.toThrow(/not accessible/);
  });

  it("throws on get/resolveUrl when the asset is unknown", async () => {
    const store = createStore();
    const media = createRuntimeMediaContext(store, undefined, TEST_OWNER);

    await expect(
      media.get({ id: "never-existed", mime: "image/png", size: 0 }),
    ).rejects.toThrow(/not accessible/);
    await expect(
      media.resolveUrl({ id: "never-existed", mime: "image/png", size: 0 }),
    ).rejects.toThrow(/not accessible/);
  });

  it("allows a session with an explicit ref row to read another session-owned asset", async () => {
    const store = createStore();
    const ownerMedia = createRuntimeMediaContext(store, undefined, TEST_OWNER);
    const ref = await ownerMedia.put(
      new Uint8Array([1, 2, 3]),
      "application/octet-stream",
    );

    // Simulate fork/inherit: framework records a ref row for the second session.
    await store.addRef(ref.id, "sess-fork", "plugin-other");

    const forkedMedia = createRuntimeMediaContext(store, undefined, {
      sessionId: "sess-fork",
      pluginId: "plugin-other",
    });

    expect(await forkedMedia.get(ref)).toEqual(new Uint8Array(3));
    expect(await forkedMedia.resolveUrl(ref)).toBe(`media:${ref.id}`);
  });

  it("grants the deduped second session its own ref at put-time so it can read the asset", async () => {
    const store = createStore();
    const bytes = new Uint8Array([9, 9, 9]);

    const sessionAMedia = createRuntimeMediaContext(store, undefined, {
      sessionId: "sess-a",
      pluginId: "plugin-a",
    });
    const refA = await sessionAMedia.put(bytes, "application/octet-stream");

    // Make the second put dedup onto refA.id so we model content-addressed
    // dedupe behaviour: same bytes → same id, no new asset row, but the
    // second session should still gain a ref row at put-time.
    const originalPut = store.put.bind(store);
    store.put = async (next, mime, meta) => {
      store.puts.push({ bytes: next, mime, meta });
      // Reuse the existing asset entry — content-addressable dedupe.
      return {
        id: refA.id,
        mime: store.assets.get(refA.id)!.mime,
        size: store.assets.get(refA.id)!.size,
      };
    };

    const sessionBMedia = createRuntimeMediaContext(store, undefined, {
      sessionId: "sess-b",
      pluginId: "plugin-b",
    });
    const refB = await sessionBMedia.put(bytes, "application/octet-stream");
    // Restore so other tests in the same suite are unaffected.
    store.put = originalPut;

    expect(refB.id).toBe(refA.id);
    // Owner stays as session A (first-writer wins).
    expect(store.assets.get(refA.id)?.ownerSessionId).toBe("sess-a");
    // Session B has an explicit ref now → it can read the bytes.
    expect(await store.isReferencedBy(refA.id, "sess-b")).toBe(true);
    expect(await sessionBMedia.get(refB)).toEqual(new Uint8Array(3));
  });

  it("records ownership after a successful ingestUrl", async () => {
    const store = createStore();
    const utils = createUtils({
      "https://ok.example.test/image": new Response(pngBytes(), {
        headers: { "content-type": "image/png" },
      }),
    });
    const media = createRuntimeMediaContext(store, utils, TEST_OWNER);

    const ref = await media.ingestUrl("https://ok.example.test/image");

    expect(store.puts).toHaveLength(1);
    expect(store.ownerships).toEqual([
      {
        id: ref.id,
        sessionId: TEST_OWNER.sessionId,
        pluginId: TEST_OWNER.pluginId,
      },
    ]);
    expect(store.refs).toEqual([
      {
        id: ref.id,
        sessionId: TEST_OWNER.sessionId,
        pluginId: TEST_OWNER.pluginId,
      },
    ]);
  });

  it("does not record ownership if ingestUrl fails before put", async () => {
    const store = createStore();
    const utils = createUtils({}, ["https://blocked.example.test/image.png"]);
    const media = createRuntimeMediaContext(store, utils, TEST_OWNER);

    await expect(
      media.ingestUrl("https://blocked.example.test/image.png"),
    ).rejects.toThrow();
    expect(store.puts).toHaveLength(0);
    expect(store.ownerships).toHaveLength(0);
  });

  it("validates the original ingest URL before fetching", async () => {
    const store = createStore();
    const utils = createUtils({}, ["https://blocked.example.test/image.png"]);
    const media = createRuntimeMediaContext(store, utils, TEST_OWNER);

    await expect(
      media.ingestUrl("https://blocked.example.test/image.png"),
    ).rejects.toThrow(/URL rejected/);
    expect(store.puts).toHaveLength(0);
  });

  it("validates redirect targets before following them", async () => {
    const store = createStore();
    const utils = createUtils(
      {
        "https://ok.example.test/start": new Response(null, {
          status: 302,
          headers: { location: "https://blocked.example.test/image.png" },
        }),
      },
      ["https://blocked.example.test/image.png"],
    );
    const media = createRuntimeMediaContext(store, utils, TEST_OWNER);

    await expect(
      media.ingestUrl("https://ok.example.test/start"),
    ).rejects.toThrow(/URL rejected/);
    expect(store.puts).toHaveLength(0);
    // The hop was requested with the explicit opt-in that makes the real
    // implementation return the 3xx instead of throwing.
    expect(utils.calls).toEqual([
      { url: "https://ok.example.test/start", redirect: "manual" },
    ]);
  });

  it("uses a separate guarded fetch for every redirect hop", async () => {
    const store = createStore();
    let hop = 0;
    const fetchWithRetry = vi
      .fn<PluginRuntimeUtils["fetchWithRetry"]>()
      .mockImplementation(async (_input, init) => {
        // Production semantics: without the explicit `redirect: "manual"`
        // opt-in a 3xx is an SSRF failure, never a followed redirect.
        if (init?.redirect !== "manual") {
          throw new Error(
            "baseUrl rejected by SSRF policy: refusing to follow redirect",
          );
        }
        hop += 1;
        return hop === 1
          ? new Response(null, {
              status: 302,
              headers: { location: "https://cdn.example.test/image.png" },
            })
          : new Response(pngBytes(), {
              headers: { "content-type": "image/png" },
            });
      });
    const utils: PluginRuntimeUtils = {
      validateBaseUrl: () => ({ ok: true }),
      fetchWithRetry,
    };
    const media = createRuntimeMediaContext(store, utils, TEST_OWNER);

    await media.ingestUrl("https://origin.example.test/start");

    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
    expect(
      fetchWithRetry.mock.calls.map(([input]) => input.toString()),
    ).toEqual([
      "https://origin.example.test/start",
      "https://cdn.example.test/image.png",
    ]);
    // Every hop opts into receiving the raw 3xx so it can be re-validated.
    expect(fetchWithRetry.mock.calls.map(([, init]) => init?.redirect)).toEqual(
      ["manual", "manual"],
    );
  });

  it("fails closed when the injected fetch refuses to expose the 3xx", async () => {
    const store = createStore();
    // A utils implementation that ignores `redirect: "manual"` and reports the
    // pre-redirect failure mode must not be turned into a silent success.
    const utils: PluginRuntimeUtils = {
      validateBaseUrl: () => ({ ok: true }),
      fetchWithRetry: async () => {
        throw new Error(
          "baseUrl rejected by SSRF policy: refusing to follow redirect (HTTP 302)",
        );
      },
    };
    const media = createRuntimeMediaContext(store, utils, TEST_OWNER);

    await expect(
      media.ingestUrl("https://origin.example.test/start"),
    ).rejects.toThrow(/refusing to follow redirect/);
    expect(store.puts).toHaveLength(0);
  });

  it("rejects a fetch implementation that silently followed a redirect", async () => {
    const store = createStore();
    const followed = new Response(pngBytes(), {
      headers: { "content-type": "image/png" },
    });
    // `Response.url` is read-only; model an implementation that auto-followed
    // by overriding it the way a real fetch response reports the final URL.
    Object.defineProperty(followed, "url", {
      value: "https://evil.example.test/internal.png",
    });
    const utils: PluginRuntimeUtils = {
      validateBaseUrl: () => ({ ok: true }),
      fetchWithRetry: async () => followed,
    };
    const media = createRuntimeMediaContext(store, utils, TEST_OWNER);

    await expect(
      media.ingestUrl("https://origin.example.test/start"),
    ).rejects.toThrow(/unvalidated redirect/);
    expect(store.puts).toHaveLength(0);
  });

  it("enforces maxBytes while reading the response body", async () => {
    const store = createStore();
    const bytes = pngBytes(32);
    const utils = createUtils({
      "https://ok.example.test/big.png": new Response(bytes, {
        headers: { "content-type": "image/png" },
      }),
    });
    const media = createRuntimeMediaContext(store, utils, TEST_OWNER);

    await expect(
      media.ingestUrl("https://ok.example.test/big.png", { maxBytes: 8 }),
    ).rejects.toThrow(/maxBytes/);
    expect(store.puts).toHaveLength(0);
  });

  it("sniffs MIME from bytes and stores the sniffed value", async () => {
    const store = createStore();
    const utils = createUtils({
      "https://ok.example.test/image": new Response(pngBytes(), {
        headers: { "content-type": "text/plain" },
      }),
    });
    const media = createRuntimeMediaContext(store, utils, TEST_OWNER);

    const ref = await media.ingestUrl("https://ok.example.test/image", {
      allowedMimes: ["image/png"],
      meta: { source: "test" },
    });

    expect(ref.mime).toBe("image/png");
    expect(store.puts[0]?.mime).toBe("image/png");
    expect(store.puts[0]?.meta).toMatchObject({
      source: "test",
      originalUrl: "https://ok.example.test/image",
    });
  });
});
