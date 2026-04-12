/**
 * Phase 0.1 — Ollama embedding smoke test via Vercel AI SDK.
 *
 * Uses @ai-sdk/openai-compatible to reach Ollama's OpenAI-compatible
 * endpoint at http://localhost:11434/v1/embeddings. Validates that
 * `ai.embedMany` returns correctly shaped vectors from a local text
 * embedding model.
 *
 * Prerequisites:
 *   ollama serve
 *   ollama pull nomic-embed-text-v2-moe   # or any embed model
 *
 * Environment:
 *   OLLAMA_BASE_URL      (default: http://localhost:11434)
 *   OLLAMA_EMBED_MODEL   (default: nomic-embed-text-v2-moe)
 *
 * Run:
 *   npx tsx scripts/embedding-bench/01-ollama-smoke.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { embedMany } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text-v2-moe';

const VALUES = [
  '你好世界，这是一段中文测试文本，用于验证嵌入模型是否工作。',
  'Hello world. This is a short English sentence for embedding smoke test.',
  '覆辙之地的迷雾在黎明前变得更加浓密，远处隐约传来教堂钟声。',
];

const DEBUG_DIR = path.resolve(import.meta.dirname, '../../debugs/embedding');
const OUT_FILE = path.join(DEBUG_DIR, 'ollama-smoke.json');

async function main() {
  console.log('🧪 Phase 0.1 — Ollama embedding smoke test');
  console.log(`   baseURL : ${OLLAMA_BASE_URL}`);
  console.log(`   model   : ${OLLAMA_EMBED_MODEL}`);
  console.log(`   values  : ${VALUES.length} strings\n`);

  const ollama = createOpenAICompatible({
    name: 'ollama',
    baseURL: `${OLLAMA_BASE_URL}/v1`,
    // Ollama doesn't require an auth key locally, but the SDK expects one.
    apiKey: process.env.OLLAMA_API_KEY ?? 'ollama-local',
  });

  const startedAt = Date.now();
  let result;
  try {
    result = await embedMany({
      model: ollama.textEmbeddingModel(OLLAMA_EMBED_MODEL),
      values: VALUES,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('❌ embedMany failed:', msg);
    console.error('\nTroubleshooting:');
    console.error(`  1. Is Ollama running?   curl ${OLLAMA_BASE_URL}/api/tags`);
    console.error(`  2. Is the model pulled? ollama pull ${OLLAMA_EMBED_MODEL}`);
    console.error('  3. Does Ollama version support /v1/embeddings? (need >= 0.1.34)');
    process.exit(1);
  }
  const elapsedMs = Date.now() - startedAt;

  const { embeddings, usage } = result;
  if (embeddings.length !== VALUES.length) {
    console.error(`❌ expected ${VALUES.length} vectors, got ${embeddings.length}`);
    process.exit(1);
  }
  const dims = embeddings.map((v) => v.length);
  const firstDim = dims[0];
  if (!dims.every((d) => d === firstDim)) {
    console.error('❌ vectors have inconsistent dimensions:', dims);
    process.exit(1);
  }

  const summary = {
    phase: '0.1',
    provider: 'ollama-openai-compatible',
    baseURL: OLLAMA_BASE_URL,
    model: OLLAMA_EMBED_MODEL,
    elapsedMs,
    valueCount: VALUES.length,
    dimensions: firstDim,
    usage,
    firstVectorPreview: embeddings[0].slice(0, 8),
    lastVectorPreview: embeddings[embeddings.length - 1].slice(0, 8),
    values: VALUES,
  };

  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(summary, null, 2));

  console.log(`✅ ${VALUES.length} vectors returned, dim=${firstDim}, usage.tokens=${usage?.tokens ?? 'n/a'}`);
  console.log(`   elapsed: ${elapsedMs} ms`);
  console.log(`   dumped : ${path.relative(process.cwd(), OUT_FILE)}\n`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
