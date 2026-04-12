/**
 * Phase 0.4 — End-to-end embedding + store + retrieval.
 *
 * Slice worlds/cloudmere/WORLD.md into ~10 chunks, embed each via
 * Ollama (Vercel AI SDK path), upsert to sqlite-vec, then issue
 * semantic queries and rank the top matches. Human verdict goes in
 * debugs/embedding/e2e-result.md.
 *
 * Run:
 *   ollama serve && ollama pull nomic-embed-text-v2-moe
 *   npx tsx scripts/embedding-bench/04-embed-store-e2e.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { embed, embedMany } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text-v2-moe';

const ROOT = path.resolve(import.meta.dirname, '../..');
const WORLD_DOC = path.join(ROOT, 'worlds/cloudmere/WORLD.md');
const DEBUG_DIR = path.join(ROOT, 'debugs/embedding');
const OUT_FILE = path.join(DEBUG_DIR, 'e2e-result.md');

const QUERIES = [
  '云梦泽最强的宗门是哪个，宗主是谁',
  '散修联盟的领袖是什么境界',
  '哪些势力可能是反派或灰色势力',
  '梦莲这种灵植有什么副作用',
];

interface Chunk {
  id: string;
  heading: string;
  text: string;
}

function chunkMarkdown(md: string): Chunk[] {
  const lines = md.split('\n');
  const chunks: Chunk[] = [];
  let currentHeading = '前言';
  let buffer: string[] = [];
  let idCounter = 0;
  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text.length >= 40) {
      chunks.push({ id: `chunk-${idCounter++}`, heading: currentHeading, text });
    }
    buffer = [];
  };
  for (const line of lines) {
    if (line.startsWith('## ') || line.startsWith('# ')) {
      flush();
      currentHeading = line.replace(/^#+\s*/, '').trim();
      continue;
    }
    // sub-paragraph split on blank line between heading sections
    if (line.trim() === '' && buffer.length > 0 && buffer.join('\n').length > 300) {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return chunks;
}

async function main() {
  console.log('🧪 Phase 0.4 — end-to-end embed + store + retrieve');
  console.log(`   model   : ${OLLAMA_EMBED_MODEL}`);
  console.log(`   corpus  : ${path.relative(ROOT, WORLD_DOC)}\n`);

  const md = fs.readFileSync(WORLD_DOC, 'utf-8');
  const chunks = chunkMarkdown(md);
  console.log(`→ ${chunks.length} chunks after splitting`);

  const ollama = createOpenAICompatible({
    name: 'ollama',
    baseURL: `${OLLAMA_BASE_URL}/v1`,
    apiKey: process.env.OLLAMA_API_KEY ?? 'ollama-local',
  });
  const embedder = ollama.textEmbeddingModel(OLLAMA_EMBED_MODEL);

  // ── embed corpus ──────────────────────────────────────────────
  const embedStart = Date.now();
  let corpusResult;
  try {
    corpusResult = await embedMany({
      model: embedder,
      values: chunks.map((c) => `${c.heading}\n\n${c.text}`),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('❌ corpus embed failed:', msg);
    console.error('\nTroubleshooting:');
    console.error(`  ollama serve && ollama pull ${OLLAMA_EMBED_MODEL}`);
    process.exit(1);
  }
  const embedMs = Date.now() - embedStart;
  const corpusEmbeddings = corpusResult.embeddings;
  const dim = corpusEmbeddings[0].length;
  console.log(`✅ corpus embedded: ${chunks.length} vectors × dim=${dim} in ${embedMs} ms`);

  // ── set up sqlite-vec ─────────────────────────────────────────
  const db = new Database(':memory:');
  sqliteVec.load(db);
  const tableName = `vec_memory_f${dim}`;
  db.exec(`
    CREATE VIRTUAL TABLE ${tableName} USING vec0(
      session_id    text partition key,
      plugin_id     text,
      namespace     text,
      data_key      text,
      +heading      text,
      +snippet      text,
      embedding     float[${dim}]
    );
  `);
  const insert = db.prepare(`
    INSERT INTO ${tableName} (session_id, plugin_id, namespace, data_key, heading, snippet, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const toJson = (v: number[]) => `[${v.join(',')}]`;
  const snippetOf = (s: string) => s.length > 160 ? s.slice(0, 160) + '…' : s;
  const insertTxn = db.transaction(() => {
    for (let i = 0; i < chunks.length; i += 1) {
      insert.run(
        'session-bench',
        'bench-embedding',
        'world-lore',
        chunks[i].id,
        chunks[i].heading,
        snippetOf(chunks[i].text),
        toJson(Array.from(corpusEmbeddings[i])),
      );
    }
  });
  insertTxn();
  console.log(`✅ upserted ${chunks.length} rows into ${tableName}`);

  // ── query ─────────────────────────────────────────────────────
  const knnStmt = db.prepare(`
    SELECT data_key, heading, snippet, distance
    FROM ${tableName}
    WHERE embedding MATCH ? AND k = 3
      AND session_id = 'session-bench'
    ORDER BY distance
  `);

  const outputLines: string[] = [];
  outputLines.push(`# Phase 0.4 — Embedding End-to-End Result`);
  outputLines.push('');
  outputLines.push(`- **Model**: \`${OLLAMA_EMBED_MODEL}\` (${OLLAMA_BASE_URL})`);
  outputLines.push(`- **Dimensions**: ${dim}`);
  outputLines.push(`- **Corpus**: \`worlds/cloudmere/WORLD.md\` → ${chunks.length} chunks`);
  outputLines.push(`- **Corpus embed time**: ${embedMs} ms`);
  outputLines.push('');
  outputLines.push(`## Chunks`);
  outputLines.push('');
  for (const c of chunks) {
    outputLines.push(`- \`${c.id}\` — **${c.heading}** (${c.text.length} chars)`);
  }
  outputLines.push('');
  outputLines.push(`## Queries`);
  outputLines.push('');

  for (const q of QUERIES) {
    const queryStart = Date.now();
    const qResult = await embed({ model: embedder, value: q });
    const qEmbed = Array.from(qResult.embedding);
    const queryEmbedMs = Date.now() - queryStart;
    const rows = knnStmt.all(toJson(qEmbed)) as Array<{
      data_key: string;
      heading: string;
      snippet: string;
      distance: number;
    }>;
    console.log(`\n→ query: ${q}`);
    console.log(`  embed: ${queryEmbedMs} ms, top-3:`);
    for (const r of rows) {
      console.log(`    ${r.distance.toFixed(4)}  [${r.data_key}] ${r.heading}`);
    }
    outputLines.push(`### ${q}`);
    outputLines.push('');
    outputLines.push(`Query embed: ${queryEmbedMs} ms`);
    outputLines.push('');
    outputLines.push('| distance | chunk | heading | snippet |');
    outputLines.push('|---|---|---|---|');
    for (const r of rows) {
      const safeSnippet = r.snippet.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      outputLines.push(`| ${r.distance.toFixed(4)} | ${r.data_key} | ${r.heading} | ${safeSnippet} |`);
    }
    outputLines.push('');
  }

  outputLines.push(`## Human Verdict`);
  outputLines.push('');
  outputLines.push('_Fill this in after inspecting: are the top results semantically relevant? ✅ / ❌_');
  outputLines.push('');

  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, outputLines.join('\n'));
  console.log(`\ndumped: ${path.relative(process.cwd(), OUT_FILE)}`);
  db.close();
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
