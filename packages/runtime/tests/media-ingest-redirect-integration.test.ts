/**
 * Media ingest redirect + HTTP permission integration.
 *
 * The unit tests for `createRuntimeMediaContext` use a hand-rolled `utils`
 * double; this suite injects the REAL production utils
 * (`@covel/ai-provider` `fetchWithRetry` + `validateBaseUrlForPlugin`, the pair
 * wired in `apps/server/src/app.ts`) against a loopback HTTP server so the
 * redirect loop is exercised end-to-end and cannot silently disagree with the
 * implementation again. It also pins that `ctx.media.ingestUrl` obeys the same
 * `permissions.http` allowlist as `ctx.utils.fetchWithRetry` for community
 * runtimes, including on redirect hops.
 */

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { fetchWithRetry, validateBaseUrlForPlugin } from "@covel/ai-provider";
import { createMemoryMediaStore } from "@covel/store";
import { createRuntimeMediaContext } from "../src/function-runtime/runtime-media-context.js";
import { enforceHttpPermissions } from "../src/function-runtime/http-permissions.js";

const PNG_HEADER = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

interface TestServer {
  readonly origin: string;
  close(): Promise<void>;
}

const servers: TestServer[] = [];

/**
 * Loopback server whose `/start` replies with a 302 to `redirectTarget`
 * (relative path = same origin, absolute URL = cross-origin hop) and whose
 * `/image.png` replies with PNG bytes.
 */
async function startRedirectServer(
  options: {
    readonly redirectTarget?: string;
  } = {},
): Promise<TestServer> {
  const target = options.redirectTarget ?? "/image.png";
  const server: Server = createServer((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { location: target });
      res.end();
      return;
    }
    if (req.url === "/image.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from(PNG_HEADER));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP listener address");
  }
  const handle: TestServer = {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  servers.push(handle);
  return handle;
}

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

function productionUtils() {
  return {
    validateBaseUrl: validateBaseUrlForPlugin,
    fetchWithRetry,
  };
}

function communityUtils(declaredOrigins: readonly string[]) {
  return enforceHttpPermissions(productionUtils(), {
    isCommunity: true,
    httpPermissions: declaredOrigins.map((origin) => ({
      origin,
      methods: ["GET"],
    })),
    runtimeId: "community/image-ingest",
  });
}

const OWNER = { sessionId: "sess-ingest", pluginId: "plugin-ingest" } as const;

describe("ctx.media.ingestUrl with the real fetchWithRetry", () => {
  it("follows a validated 302 → 200 hop and stores the bytes", async () => {
    const server = await startRedirectServer({});
    const mediaStore = createMemoryMediaStore();
    const media = createRuntimeMediaContext(
      mediaStore,
      productionUtils(),
      OWNER,
    );

    const ref = await media.ingestUrl(`${server.origin}/start`);

    expect(ref.mime).toBe("image/png");
    expect(ref.size).toBe(PNG_HEADER.byteLength);
    const stored = await mediaStore.get(ref);
    const bytes =
      stored instanceof Uint8Array
        ? stored
        : new Uint8Array(await stored.arrayBuffer());
    expect(bytes).toEqual(PNG_HEADER);
    const [asset] = await mediaStore.listByMetadata(OWNER.sessionId, {});
    expect(asset?.meta).toMatchObject({
      originalUrl: `${server.origin}/start`,
      finalUrl: `${server.origin}/image.png`,
    });
  });

  it("rejects an undeclared origin for a community runtime", async () => {
    const allowed = await startRedirectServer({});
    const other = await startRedirectServer({});
    const mediaStore = createMemoryMediaStore();
    const media = createRuntimeMediaContext(
      mediaStore,
      communityUtils([allowed.origin]),
      OWNER,
    );

    await expect(media.ingestUrl(`${other.origin}/start`)).rejects.toThrow(
      /http permission denied/,
    );
    expect(await mediaStore.listAssets()).toHaveLength(0);
  });

  it("rejects a redirect hop that leaves the community allowlist", async () => {
    const allowed = await startRedirectServer({});
    const other = await startRedirectServer({});
    // `allowed` answers with a 302 pointing at the *other* origin, which the
    // community runtime never declared: the hop must be denied, not followed.
    const hopping = await startRedirectServer({
      redirectTarget: `${other.origin}/image.png`,
    });
    const mediaStore = createMemoryMediaStore();
    const media = createRuntimeMediaContext(
      mediaStore,
      communityUtils([allowed.origin, hopping.origin]),
      OWNER,
    );

    await expect(media.ingestUrl(`${hopping.origin}/start`)).rejects.toThrow(
      /http permission denied/,
    );
    expect(await mediaStore.listAssets()).toHaveLength(0);
  });

  it("lets a community runtime ingest when the origin is declared", async () => {
    const server = await startRedirectServer({});
    const mediaStore = createMemoryMediaStore();
    const media = createRuntimeMediaContext(
      mediaStore,
      communityUtils([server.origin]),
      OWNER,
    );

    const ref = await media.ingestUrl(`${server.origin}/start`);
    expect(ref.mime).toBe("image/png");
  });

  it("fails closed when the redirect budget is exhausted", async () => {
    const server = await startRedirectServer({
      redirectTarget: "/start",
    });
    const mediaStore = createMemoryMediaStore();
    const media = createRuntimeMediaContext(mediaStore, productionUtils(), {
      ...OWNER,
      maxRedirects: 2,
    });

    await expect(media.ingestUrl(`${server.origin}/start`)).rejects.toThrow(
      /exceeded redirect limit/,
    );
    expect(await mediaStore.listAssets()).toHaveLength(0);
  });
});
