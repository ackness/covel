/**
 * Live integration tests for image generation.
 *
 * COST CONTROL:
 * - Tests are SKIPPED by default. Run with: LIVE_IMAGE_ENABLED=1
 * - Generated images are CACHED to .test-image-cache/ so re-runs don't
 *   incur extra API costs. Delete the cache folder to force re-generation.
 * - Each test writes the image to disk for manual quality inspection.
 *
 * Usage:
 *   LIVE_IMAGE_ENABLED=1 DASHSCOPE_API_KEY=sk-... \
 *     pnpm --filter @covel/ai-provider test --run tests/live/image-generation.test.ts
 *
 * Output images are saved to:
 *   packages/ai-provider/tests/live/.image-cache/
 */
import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createOpenAiChatAdapter } from "../../src/adapters/openai-chat.js";
import type { ProviderConfig } from "../../src/types.js";

const LIVE = process.env.LIVE_IMAGE_ENABLED === "1";

const __dirname_esm = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dirname_esm, ".image-cache");

function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

/**
 * Cache-aware image generation helper.
 * If a cached result exists, returns it immediately without API call.
 * Otherwise calls the API, saves the result, and returns it.
 */
async function cachedGenerateImage(
  cacheKey: string,
  generate: () => Promise<{ url?: string; dataBase64?: string; mimeType: string }>,
): Promise<{ url?: string; dataBase64?: string; mimeType: string; fromCache: boolean }> {
  ensureCacheDir();
  const metaPath = resolve(CACHE_DIR, `${cacheKey}.json`);

  if (existsSync(metaPath)) {
    const cached = JSON.parse(readFileSync(metaPath, "utf-8"));
    return { ...cached, fromCache: true };
  }

  const result = await generate();

  // Persist result metadata
  writeFileSync(metaPath, JSON.stringify({ url: result.url, mimeType: result.mimeType }, null, 2));

  // If base64, also write the image file
  if (result.dataBase64) {
    const ext = result.mimeType.split("/")[1] ?? "png";
    const imgPath = resolve(CACHE_DIR, `${cacheKey}.${ext}`);
    writeFileSync(imgPath, Buffer.from(result.dataBase64, "base64"));
    console.log(`[image-test] Saved image to: ${imgPath}`);
  }

  if (result.url) {
    // Download and cache the image for quality inspection
    try {
      const resp = await fetch(result.url);
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer());
        const contentType = resp.headers.get("content-type") ?? result.mimeType;
        const ext = contentType.split("/")[1]?.split(";")[0] ?? "png";
        const imgPath = resolve(CACHE_DIR, `${cacheKey}.${ext}`);
        writeFileSync(imgPath, buf);
        console.log(`[image-test] Downloaded & saved: ${imgPath}`);
      }
    } catch {
      // Non-fatal: URL may be temporary
    }
  }

  return { ...result, fromCache: false };
}

// ── DashScope WAN live test ───────────────────────────────────────

describe.skipIf(!LIVE)("live image generation: DashScope WAN", () => {
  it(
    "should generate an image with wan2.7-image-pro and save to cache",
    { timeout: 120_000 },
    async () => {
      const apiKey = process.env.DASHSCOPE_API_KEY;
      if (!apiKey) throw new Error("DASHSCOPE_API_KEY not set");

      const config: ProviderConfig = {
        baseUrl: "https://dashscope.aliyuncs.com",
        apiKey,
        headers: {},
      };

      const adapter = createOpenAiChatAdapter();

      const result = await cachedGenerateImage("dashscope-wan-flower-shop", async () => {
        const res = await adapter.generateImage(config, {
          model: "wan2.7-image-pro",
          prompt: "一间有着精致窗户的花店，漂亮的木质门，摆放着花朵，水彩风格，柔和色调",
          providerRequestMetadata: {
            imageFormat: "dashscope-wan",
            size: "1024*1024",
            n: 1,
            watermark: false,
          },
        });
        const first = res.images[0];
        if (!first) throw new Error("No image returned");
        return first;
      });

      console.log(`[dashscope-wan] fromCache=${result.fromCache}, url=${result.url ?? "(base64)"}`);
      expect(result.url || result.dataBase64).toBeTruthy();
    },
  );
});

// ── OpenAI chat completions image format live test ────────────────

describe.skipIf(!LIVE || !process.env.OPENAI_API_KEY)("live image generation: OpenAI chat format", () => {
  it(
    "should generate an image via chat completions format",
    { timeout: 60_000 },
    async () => {
      const apiKey = process.env.OPENAI_API_KEY!;
      const config: ProviderConfig = {
        baseUrl: "https://api.openai.com",
        apiKey,
        headers: {},
      };

      const adapter = createOpenAiChatAdapter();

      const result = await cachedGenerateImage("openai-chat-cat", async () => {
        const res = await adapter.generateImage(config, {
          model: "gpt-4o-image",
          prompt: "A fluffy orange cat sitting on a windowsill, watercolor style, soft pastel colors",
          providerRequestMetadata: { imageFormat: "openai-chat" },
        });
        const first = res.images[0];
        if (!first) throw new Error("No image returned");
        return first;
      });

      console.log(`[openai-chat] fromCache=${result.fromCache}, url=${result.url ?? "(base64)"}`);
      expect(result.url || result.dataBase64).toBeTruthy();
    },
  );
});
