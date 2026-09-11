/**
 * image-gen-common.mjs — shared slot/key/wire resolution and generation
 * primitives for the offline image-gen author scripts (generate-portraits.mjs,
 * generate-scenes.mjs).
 *
 * This module imports framework TS source directly (no build step for dev
 * packages) — run consumers under tsx, not plain node.
 */
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseEnv } from "node:util";
import { loadLlmConfig } from "../../packages/ai-provider/src/config/llm-loader.ts";
import { providerApiKeyEnvName } from "../../packages/shared/src/env/index.ts";
import {
  getImageWire,
  DEFAULT_IMAGE_WIRE,
} from "../../packages/ai-provider/src/image/wire-registry.ts";
import { validateBaseUrl } from "../../packages/ai-provider/src/adapters/http.ts";

function covelHome() {
  return process.env.COVEL_HOME || path.join(os.homedir(), ".covel");
}

async function readKeysEnv() {
  try {
    return parseEnv(
      await readFile(path.join(covelHome(), "keys.env"), "utf-8"),
    );
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

export const exists = (p) =>
  access(p)
    .then(() => true)
    .catch(() => false);

/** Run `worker` over items with a bounded concurrency pool. */
export async function pool(items, limit, worker) {
  const results = Array.from({ length: items.length });
  let idx = 0;
  const run = async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export async function fetchImageBytes({
  wire,
  config,
  model,
  prompt,
  size,
  quality,
  background,
}) {
  const result = await wire.generate(config, {
    model,
    prompt,
    size,
    quality,
    n: 1,
    background,
  });
  const img = result.images[0];
  if (!img) throw new Error("wire returned no images");
  if (img.kind === "bytes") return img.bytes;
  // Minimal SSRF + content-type guard. The wire returns a direct provider
  // URL (not user input), so no redirect-hop revalidation is needed.
  if (!validateBaseUrl(img.url)) {
    throw new Error(`image url rejected by SSRF policy: ${img.url}`);
  }
  const res = await fetch(img.url);
  if (!res.ok) throw new Error(`fetch image url failed: HTTP ${res.status}`);
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.startsWith("image/")) {
    throw new Error(
      `image url returned non-image content-type: ${ct || "(none)"}`,
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Print the ok/failed summary for a pool() result array and exit(2) if any
 * task failed — shared tail of generate-portraits.mjs / generate-scenes.mjs.
 */
export function reportResults(results) {
  const failed = results.filter((r) => r.status === "failed");
  console.log(
    `\ndone: ${results.filter((r) => r.status === "ok").length} ok, ${failed.length} failed`,
  );
  if (failed.length) {
    console.log(
      "re-run to retry failed (existing ones are skipped):",
      failed.map((f) => f.id).join(", "),
    );
    process.exit(2);
  }
}

/**
 * Resolve slot → { wire, config, model, slot } for offline generation.
 * Uses the application TOML loader, including validation and env interpolation.
 * Throws before making a request when configuration is incomplete.
 */
export async function resolveImageWire(slotName) {
  const configPath =
    process.env.COVEL_LLM_TOML || path.join(covelHome(), "llm.toml");
  const slot = loadLlmConfig(configPath)?.llmConfig.covel[slotName];
  if (!slot) {
    throw new Error(
      `Slot [covel.${slotName}] missing in ${configPath}. Configure it or pick another --slot.`,
    );
  }
  const { baseUrl, model } = slot;
  const keyName = providerApiKeyEnvName(slot.provider);
  if (!keyName) throw new Error(`Invalid provider id in slot ${slotName}.`);
  const explicitKey = process.env.COVEL_IMG_KEY || process.env[keyName];
  const keys = explicitKey ? {} : await readKeysEnv();
  const apiKey =
    explicitKey ||
    keys[keyName] ||
    process.env.OPENAI_API_KEY ||
    keys.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      `No API key. Set ${keyName} in the environment or ${path.join(covelHome(), "keys.env")} (or use COVEL_IMG_KEY).`,
    );
  }
  const wireId = slot.providerRequestMetadata?.imageWire ?? DEFAULT_IMAGE_WIRE;
  const wire = getImageWire(wireId);
  if (!wire) {
    throw new Error(
      `Unknown image wire "${wireId}". Check llm.toml providerRequestMetadata.imageWire.`,
    );
  }
  return {
    wire,
    wireId,
    model,
    slot,
    config: { baseUrl, apiKey },
  };
}
