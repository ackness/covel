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
import {
  getImageWire,
  DEFAULT_IMAGE_WIRE,
} from "../../packages/ai-provider/src/image/wire-registry.ts";
import { validateBaseUrl } from "../../packages/ai-provider/src/adapters/http.ts";

/**
 * Read a `[covel.<slot>]` block from ~/.covel/llm.toml into a flat object,
 * plus `imageWire` from either a `[covel.<slot>.providerRequestMetadata]`
 * subtable (the real schema field) or a flat `imageWire` key directly under
 * `[covel.<slot>]` (script-only convenience).
 */
async function readSlot(slotName) {
  const p = path.join(os.homedir(), ".covel", "llm.toml");
  const txt = await readFile(p, "utf-8");
  const out = {};
  let section = null;
  for (const line of txt.split("\n")) {
    const sec = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (sec) {
      section = sec[1];
      continue;
    }
    const inSlot = section === `covel.${slotName}`;
    const inMeta = section === `covel.${slotName}.providerRequestMetadata`;
    if (!inSlot && !inMeta) continue;
    const kv = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    const value = kv[2].replace(/^["']|["']$/g, "").trim();
    if (inMeta && kv[1] === "imageWire") out.imageWire = value;
    else if (inSlot) out[kv[1]] = value;
  }
  return out;
}

async function readKeysEnv(name) {
  const p = path.join(os.homedir(), ".covel", "keys.env");
  try {
    const txt = await readFile(p, "utf-8");
    for (const line of txt.split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, "").trim();
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export const exists = (p) =>
  access(p)
    .then(() => true)
    .catch(() => false);

/** Run `worker` over items with a bounded concurrency pool. */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
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
 * Exits the process with a readable error when config is incomplete —
 * these are author-facing CLI tools, not library code.
 */
export async function resolveImageWire(slotName) {
  const slot = await readSlot(slotName);
  const { baseUrl, model } = slot;
  const provider = (slot.provider || "openai").toUpperCase();
  if (!baseUrl || !model) {
    console.error(
      `Slot [covel.${slotName}] missing baseUrl/model in ~/.covel/llm.toml. Configure it (or pick another --slot).`,
    );
    process.exit(1);
  }
  const apiKey =
    process.env.COVEL_IMG_KEY ||
    (await readKeysEnv(`${provider}_API_KEY`)) ||
    (await readKeysEnv("OPENAI_API_KEY"));
  if (!apiKey) {
    console.error(
      `No API key. Set ${provider}_API_KEY in ~/.covel/keys.env (or COVEL_IMG_KEY env).`,
    );
    process.exit(1);
  }
  const wireId = slot.imageWire || DEFAULT_IMAGE_WIRE;
  const wire = getImageWire(wireId);
  if (!wire) {
    console.error(
      `unknown image wire "${wireId}" — register it via registerImageWire() or fix llm.toml providerRequestMetadata.imageWire`,
    );
    process.exit(1);
  }
  return {
    wire,
    wireId,
    model,
    slot,
    config: { baseUrl, apiKey },
  };
}
