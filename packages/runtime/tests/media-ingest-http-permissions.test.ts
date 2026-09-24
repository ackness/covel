/**
 * `permissions.http` coverage for `ctx.media.ingestUrl`.
 *
 * `ctx.media` is built from the same permission-enforcing utils facade as
 * `ctx.utils`, so a community runtime cannot use media ingest as an
 * undeclared outbound channel (audit review-contract-security S2). Trusted
 * (builtin) runtimes stay unenforced — SSRF policy still applies to both.
 *
 * The utils double mirrors the production injection
 * (`@covel/ai-provider` `plugin-utils.fetchWithRetry`): a 3xx is only returned
 * when the caller explicitly opts in with `redirect: "manual"`.
 */

import { describe, it, expect } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type { PluginRuntimeUtils } from "@covel/plugin-loader";
import { createMemoryStore, createMemoryMediaStore } from "@covel/store";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";

const PNG_HEADER = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function productionShapedUtils(): PluginRuntimeUtils & {
  readonly fetched: string[];
} {
  const fetched: string[] = [];
  return {
    fetched,
    validateBaseUrl: (url) =>
      url.startsWith("http://") || url.startsWith("https://")
        ? { ok: true }
        : { ok: false, reason: `unsupported protocol: ${url}` },
    async fetchWithRetry(input, init) {
      const url = input.toString();
      fetched.push(url);
      if (url.includes("/redirect")) {
        if (init?.redirect !== "manual") {
          throw new Error(
            `baseUrl rejected by SSRF policy: refusing to follow redirect (HTTP 302) from "${url}".`,
          );
        }
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example.test/image.png" },
        });
      }
      return new Response(PNG_HEADER, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    },
  };
}

function fnManifest(overrides: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return {
    name: "media-ingest/ingest-runtime",
    pluginId: "media-ingest",
    description: "media ingest permission probe",
    stage: "narrative",
    runtimeType: "function",
    handler: "./h.js",
    trigger: { type: "manual" },
    ...overrides,
  };
}

function makeTurnInput(runtimeId: string): TurnInput {
  return {
    sessionId: "sess-media-perms",
    turnId: "turn-media-perms",
    playerMessage: "",
    manualTrigger: { runtimeId },
  };
}

async function runIngest(options: {
  readonly manifest: RuntimeManifest;
  readonly targetUrl: string;
  readonly pluginSource: "community" | "builtin";
}): Promise<{ error: string | undefined; fetched: readonly string[] }> {
  const utils = productionShapedUtils();
  let error: string | undefined;

  const deps: TurnExecutorDeps = {
    loadRuntime: async () => ({
      manifest: options.manifest,
      promptTemplate: "",
      handler: async (ctx: { media?: { ingestUrl(url: string): unknown } }) => {
        try {
          await ctx.media?.ingestUrl(options.targetUrl);
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
        return { ok: true };
      },
    }),
    llm: {
      generate: async () => ({
        content: "{}",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    },
    store: createMemoryStore(),
    mediaStore: createMemoryMediaStore(),
    utils,
    getPluginSource: () => options.pluginSource,
  };

  await executeTurn(
    makeTurnInput(options.manifest.name),
    [options.manifest],
    deps,
  );
  return { error, fetched: utils.fetched };
}

describe("ctx.media.ingestUrl obeys permissions.http", () => {
  it("denies a community runtime an undeclared origin without sending the request", async () => {
    const { error, fetched } = await runIngest({
      manifest: fnManifest({ permissions: { http: [] } }),
      targetUrl: "https://cdn.example.test/image.png",
      pluginSource: "community",
    });

    expect(error).toMatch(/http permission denied/);
    expect(fetched).toEqual([]);
  });

  it("allows a declared origin and validates every redirect hop", async () => {
    const { error, fetched } = await runIngest({
      manifest: fnManifest({
        permissions: {
          http: [
            { origin: "https://img.example.test", methods: ["GET"] },
            { origin: "https://cdn.example.test", methods: ["GET"] },
          ],
        },
      }),
      targetUrl: "https://img.example.test/redirect",
      pluginSource: "community",
    });

    expect(error).toBeUndefined();
    expect(fetched).toEqual([
      "https://img.example.test/redirect",
      "https://cdn.example.test/image.png",
    ]);
  });

  it("denies a community runtime whose redirect hop leaves the allowlist", async () => {
    const { error, fetched } = await runIngest({
      manifest: fnManifest({
        permissions: {
          http: [{ origin: "https://img.example.test", methods: ["GET"] }],
        },
      }),
      targetUrl: "https://img.example.test/redirect",
      pluginSource: "community",
    });

    expect(error).toMatch(/http permission denied/);
    // The first hop was permitted; the second was rejected before fetching.
    expect(fetched).toEqual(["https://img.example.test/redirect"]);
  });

  it("does not enforce permissions.http for a trusted builtin runtime", async () => {
    const { error } = await runIngest({
      manifest: fnManifest({ permissions: { http: [] } }),
      targetUrl: "https://cdn.example.test/image.png",
      pluginSource: "builtin",
    });

    expect(error).toBeUndefined();
  });
});
