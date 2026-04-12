/**
 * Phase 0.2 — OpenRouter Nemotron multimodal embedding test.
 *
 * Validates that OpenRouter accepts the non-standard multimodal
 * embeddings request shape (content array with text + image_url parts)
 * for nvidia/llama-nemotron-embed-vl-1b-v2:free.
 *
 * Uses raw fetch (Phase 0 — validating the HTTP contract). In Phase 1
 * this gets wrapped as EmbeddingModelV2<NemotronInput> for the Vercel
 * AI SDK, but first we need to confirm the upstream shape actually
 * works.
 *
 * Prerequisites:
 *   OPENROUTER_API_KEY set in .env.llm
 *
 * Run:
 *   npx tsx --env-file=.env.llm scripts/embedding-bench/02-openrouter-nemotron-custom.ts
 */

import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
const MODEL = 'nvidia/llama-nemotron-embed-vl-1b-v2:free';
const API_KEY = process.env.OPENROUTER_API_KEY;

const DEBUG_DIR = path.resolve(import.meta.dirname, '../../debugs/embedding');
const OUT_FILE = path.join(DEBUG_DIR, 'nemotron-multimodal.json');

type TextPart = { type: 'text'; text: string };
type ImagePart = { type: 'image_url'; image_url: { url: string } };
type ContentPart = TextPart | ImagePart;
type NemotronInput = { content: ContentPart[] };

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number; object?: string }>;
  model?: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
  error?: { message: string; code?: number; type?: string };
}

async function callNemotron(inputs: NemotronInput[]): Promise<EmbeddingResponse> {
  if (!API_KEY) {
    throw new Error('OPENROUTER_API_KEY not set. Add it to .env.llm and re-run with --env-file=.env.llm');
  }
  const body = {
    model: MODEL,
    input: inputs,
    encoding_format: 'float',
  };
  const res = await fetch(`${BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/covel-dev/covel',
      'X-Title': 'Covel Embedding Bench',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: EmbeddingResponse;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response (${res.status}): ${text.slice(0, 500)}`);
  }
  if (!res.ok || json.error) {
    throw new Error(
      `HTTP ${res.status}: ${json.error?.message ?? text.slice(0, 500)}`,
    );
  }
  return json;
}

async function main() {
  console.log('🧪 Phase 0.2 — OpenRouter Nemotron multimodal smoke');
  console.log(`   baseURL : ${BASE_URL}`);
  console.log(`   model   : ${MODEL}\n`);

  const caseTextOnly: NemotronInput[] = [
    {
      content: [
        { type: 'text', text: 'A medieval marketplace at dawn, cobblestone streets damp with fog.' },
      ],
    },
    {
      content: [
        { type: 'text', text: '一位戴着银质面具的商人悄悄走进雾气弥漫的巷子。' },
      ],
    },
  ];

  const caseMultimodal: NemotronInput[] = [
    {
      content: [
        { type: 'text', text: 'What is in this image?' },
        {
          type: 'image_url',
          image_url: {
            url: 'https://live.staticflickr.com/3851/14825276609_098cac593d_b.jpg',
          },
        },
      ],
    },
  ];

  const result: Record<string, unknown> = {
    phase: '0.2',
    provider: 'openrouter',
    model: MODEL,
    cases: {},
  };

  for (const [label, inputs] of [
    ['text-only', caseTextOnly],
    ['text-plus-image', caseMultimodal],
  ] as const) {
    console.log(`→ case: ${label} (${inputs.length} input${inputs.length === 1 ? '' : 's'})`);
    const startedAt = Date.now();
    try {
      const response = await callNemotron(inputs);
      const elapsedMs = Date.now() - startedAt;
      const dims = response.data.map((d) => d.embedding.length);
      const firstDim = dims[0];
      const consistent = dims.every((d) => d === firstDim);
      console.log(
        `  ✅ ${response.data.length} vector${response.data.length === 1 ? '' : 's'}, dim=${firstDim}, consistent=${consistent}, elapsed=${elapsedMs}ms`,
      );
      (result.cases as Record<string, unknown>)[label] = {
        ok: true,
        elapsedMs,
        dimensions: firstDim,
        consistent,
        count: response.data.length,
        usage: response.usage ?? null,
        firstVectorPreview: response.data[0].embedding.slice(0, 8),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ❌ ${msg}`);
      (result.cases as Record<string, unknown>)[label] = {
        ok: false,
        error: msg,
      };
    }
  }

  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));
  console.log(`\ndumped: ${path.relative(process.cwd(), OUT_FILE)}`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
