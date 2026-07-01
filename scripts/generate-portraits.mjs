#!/usr/bin/env node
/**
 * generate-portraits.mjs — batch-generate character portraits for a world.
 *
 * Reads worlds/<world>/media/portraits.json, composes each prompt as
 * style.prefix + character.subject + style.suffix, and POSTs to an
 * OpenAI-Images-compatible endpoint ({baseUrl}/v1/images/generations,
 * Bearer auth, { model, prompt, n, size, quality } — same wire as the
 * openai-image-gen plugin). Saves PNGs to
 * worlds/<world>/media/portraits/<filename>.
 *
 * Provider config is NOT hardcoded here — it is read from a slot in
 * ~/.covel/llm.toml (baseUrl / model / provider). The API key is read from
 * ~/.covel/keys.env by the `<PROVIDER>_API_KEY` convention. Pick the slot
 * with --slot; switch providers by editing llm.toml, never this script.
 *
 * Usage:
 *   node scripts/generate-portraits.mjs <world> [--slot gpt-image-2]
 *        [--only id1,id2] [--size WxH] [--quality low|medium|high]
 *        [--limit N] [--concurrency N] [--force]
 */
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const repoRoot = path.resolve(import.meta.dirname, "..");
const DEFAULT_SLOT = "gpt-image-2";
const DEFAULT_CONCURRENCY = 5;

function parseArgs(argv) {
  const args = {
    force: false,
    concurrency: DEFAULT_CONCURRENCY,
    slot: DEFAULT_SLOT,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") args.only = new Set(argv[++i].split(","));
    else if (a === "--size") args.size = argv[++i];
    else if (a === "--quality") args.quality = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--concurrency")
      args.concurrency = Math.max(1, Number(argv[++i]) || DEFAULT_CONCURRENCY);
    else if (a === "--slot") args.slot = argv[++i];
    else if (a === "--force") args.force = true;
    else rest.push(a);
  }
  args.world = rest[0];
  return args;
}

/** Read a `[covel.<slot>]` block from ~/.covel/llm.toml into a flat object. */
async function readSlot(slotName) {
  const p = path.join(os.homedir(), ".covel", "llm.toml");
  const txt = await readFile(p, "utf-8");
  const out = {};
  let inBlock = false;
  for (const line of txt.split("\n")) {
    const sec = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (sec) {
      inBlock = sec[1] === `covel.${slotName}`;
      continue;
    }
    if (!inBlock) continue;
    const kv = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
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

function imagesEndpoint(baseUrl) {
  const t = String(baseUrl).trim().replace(/\/+$/, "");
  return t.endsWith("/v1")
    ? `${t}/images/generations`
    : `${t}/v1/images/generations`;
}

const asArray = (v) => (Array.isArray(v) ? v : undefined);

/** Permissive image extraction — mirrors openai-image-gen's collectOpenAiImages. */
function collectImages(json) {
  const out = [];
  const push = (v) => {
    if (typeof v !== "string" || v.trim().length === 0) return;
    const raw = v.trim();
    if (/^https?:\/\//i.test(raw)) out.push({ kind: "url", url: raw });
    else {
      const m = /^data:[^;,]*;base64,([\s\S]+)$/i.exec(raw);
      if (m) out.push({ kind: "b64", b64: m[1].replace(/\s+/g, "") });
      else if (raw.replace(/\s+/g, "").length >= 64)
        out.push({ kind: "b64", b64: raw.replace(/\s+/g, "") });
    }
  };
  for (const item of asArray(json?.data) ?? []) {
    if (item && typeof item === "object") {
      push(item.b64_json);
      push(item.url);
    }
  }
  for (const choice of asArray(json?.choices) ?? []) {
    for (const part of asArray(choice?.message?.content) ?? []) {
      if (part && typeof part === "object") {
        push(part.image);
        push(part.url);
        push(part.b64_json);
      }
    }
  }
  return out;
}

async function generateOne({ endpoint, key, model, prompt, size, quality }) {
  const body = { model, prompt, n: 1, size };
  if (quality) body.quality = quality;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text.length ? JSON.parse(text) : {};
  } catch {
    json = undefined;
  }
  if (!res.ok)
    throw new Error(
      `HTTP ${res.status}: ${json?.error?.message ?? json?.error ?? text.slice(0, 400)}`,
    );
  const imgs = collectImages(json);
  if (imgs.length === 0)
    throw new Error(`no image in response: ${text.slice(0, 300)}`);
  const img = imgs[0];
  if (img.kind === "b64") return Buffer.from(img.b64, "base64");
  const r = await fetch(img.url);
  if (!r.ok) throw new Error(`fetch image url failed: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

const exists = (p) =>
  access(p)
    .then(() => true)
    .catch(() => false);

/** Run `worker` over items with a bounded concurrency pool. */
async function pool(items, limit, worker) {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.world) {
    console.error(
      "usage: node scripts/generate-portraits.mjs <world> [--slot gpt-image-2] [--only id1,id2] [--size 1024x1536] [--quality medium] [--limit N] [--concurrency 5] [--force]",
    );
    process.exit(1);
  }

  const manifest = JSON.parse(
    await readFile(
      path.join(repoRoot, "worlds", args.world, "media", "portraits.json"),
      "utf-8",
    ),
  );
  const outDir = path.join(
    repoRoot,
    "worlds",
    args.world,
    "media",
    "portraits",
  );
  await mkdir(outDir, { recursive: true });

  const slot = await readSlot(args.slot);
  const baseUrl = slot.baseUrl;
  const model = slot.model;
  const provider = (slot.provider || "openai").toUpperCase();
  if (!baseUrl || !model) {
    console.error(
      `Slot [covel.${args.slot}] missing baseUrl/model in ~/.covel/llm.toml. Configure it (or pick another --slot).`,
    );
    process.exit(1);
  }
  const key =
    process.env.COVEL_IMG_KEY ||
    (await readKeysEnv(`${provider}_API_KEY`)) ||
    (await readKeysEnv("OPENAI_API_KEY"));
  if (!key) {
    console.error(
      `No API key. Set ${provider}_API_KEY in ~/.covel/keys.env (or COVEL_IMG_KEY env).`,
    );
    process.exit(1);
  }
  const endpoint = imagesEndpoint(baseUrl);
  const size = args.size || manifest.defaults?.size || "1024x1536";
  const quality = args.quality || manifest.defaults?.quality || "medium";
  const { prefix = "", suffix = "", negative = "" } = manifest.style || {};

  let chars = manifest.characters;
  if (args.only) chars = chars.filter((c) => args.only.has(c.id));
  if (args.limit) chars = chars.slice(0, args.limit);

  // Filter out already-present files up front (unless --force).
  const todo = [];
  for (const c of chars) {
    if (!args.force && (await exists(path.join(outDir, c.filename)))) {
      console.log(`  ⏭  ${c.name} (${c.filename}) exists — skip`);
    } else {
      todo.push(c);
    }
  }

  console.log(
    `world=${args.world} slot=${args.slot} (provider=${slot.provider}) model=${model} size=${size} quality=${quality} concurrency=${args.concurrency}`,
  );
  console.log(
    `generating ${todo.length} portrait(s) concurrently → worlds/${args.world}/media/portraits/\n`,
  );

  const results = await pool(todo, args.concurrency, async (c) => {
    const prompt = `${prefix}${c.subject}${suffix}${negative ? `\n\nAvoid: ${negative}` : ""}`;
    const t0 = Date.now();
    try {
      const buf = await generateOne({
        endpoint,
        key,
        model,
        prompt,
        size,
        quality,
      });
      await writeFile(path.join(outDir, c.filename), buf);
      console.log(
        `  ✅ ${c.name} (${c.filename}) ${(buf.length / 1024).toFixed(0)} KB · ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
      return { id: c.id, status: "ok" };
    } catch (err) {
      console.log(`  ❌ ${c.name} (${c.filename}) ${err.message}`);
      return { id: c.id, status: "failed", error: err.message };
    }
  });

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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
