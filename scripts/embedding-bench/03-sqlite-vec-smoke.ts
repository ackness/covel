/**
 * Phase 0.3 — sqlite-vec smoke test.
 *
 * Validates that sqlite-vec loads cleanly under better-sqlite3, can
 * create a vec0 virtual table with partition keys + metadata columns +
 * auxiliary columns, supports insertion, and supports KNN with hybrid
 * metadata filtering.
 *
 * Run:
 *   npx tsx scripts/embedding-bench/03-sqlite-vec-smoke.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const DEBUG_DIR = path.resolve(import.meta.dirname, '../../debugs/embedding');
const LOG_FILE = path.join(DEBUG_DIR, 'sqlite-vec-smoke.log');
const DIM = 768;
const ROW_COUNT = 100;
const SESSIONS = ['session-A', 'session-B'];
const PLUGINS = ['core-npc-graph', 'core-codex'];
const NAMESPACES = ['nodes', 'edges'];

function randomVector(dim: number, seed: number): Float32Array {
  const v = new Float32Array(dim);
  // deterministic-ish pseudorandom so reruns are stable
  let x = Math.sin(seed + 1) * 10000;
  for (let i = 0; i < dim; i += 1) {
    x = Math.sin(x + i) * 10000;
    v[i] = x - Math.floor(x);
  }
  // l2 normalize for cosine-friendly comparisons
  let norm = 0;
  for (const f of v) norm += f * f;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i += 1) v[i] /= norm;
  return v;
}

function toJsonVector(v: Float32Array): string {
  return `[${Array.from(v).join(',')}]`;
}

async function main() {
  const logLines: string[] = [];
  const log = (line: string) => {
    console.log(line);
    logLines.push(line);
  };

  log('🧪 Phase 0.3 — sqlite-vec smoke test');

  const db = new Database(':memory:');

  try {
    sqliteVec.load(db);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`❌ sqliteVec.load failed: ${msg}`);
    log('   Check platform prebuilt binary availability for sqlite-vec.');
    process.exit(1);
  }

  const versionRow = db
    .prepare('SELECT vec_version() AS version, sqlite_version() AS sqlite')
    .get() as { version: string; sqlite: string };
  log(`   sqlite_version : ${versionRow.sqlite}`);
  log(`   vec_version    : ${versionRow.version}`);
  log(`   dimensions     : ${DIM}`);
  log(`   row count      : ${ROW_COUNT}`);

  // vec0 virtual table: partition by session, filterable metadata, aux payload
  const tableName = `vec_memory_f${DIM}`;
  const ddl = `
    CREATE VIRTUAL TABLE ${tableName} USING vec0(
      session_id    text partition key,
      plugin_id     text,
      namespace     text,
      data_key      text,
      +payload      text,
      embedding     float[${DIM}]
    );
  `;
  try {
    db.exec(ddl);
    log(`✅ created virtual table ${tableName}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`❌ CREATE VIRTUAL TABLE failed: ${msg}`);
    log('   DDL was:\n' + ddl);
    process.exit(1);
  }

  const insert = db.prepare(`
    INSERT INTO ${tableName} (
      session_id, plugin_id, namespace, data_key, payload, embedding
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const started = Date.now();
  const insertTxn = db.transaction(() => {
    for (let i = 0; i < ROW_COUNT; i += 1) {
      const session = SESSIONS[i % SESSIONS.length];
      const plugin = PLUGINS[i % PLUGINS.length];
      const ns = NAMESPACES[i % NAMESPACES.length];
      const key = `row-${i}`;
      const payload = `row #${i} in ${plugin}/${ns}`;
      const vec = randomVector(DIM, i);
      insert.run(session, plugin, ns, key, payload, toJsonVector(vec));
    }
  });
  insertTxn();
  const insertMs = Date.now() - started;
  log(`✅ inserted ${ROW_COUNT} rows in ${insertMs} ms`);

  // sanity: row count
  const countRow = db
    .prepare(`SELECT count(*) AS n FROM ${tableName}`)
    .get() as { n: number };
  log(`   row count via count(*): ${countRow.n}`);

  // KNN: pure vector search (no filter)
  const query = randomVector(DIM, 42);
  const queryJson = toJsonVector(query);

  const knnPlain = db
    .prepare(`
      SELECT data_key, plugin_id, namespace, session_id, distance
      FROM ${tableName}
      WHERE embedding MATCH ? AND k = 5
      ORDER BY distance
    `)
    .all(queryJson) as Array<{
      data_key: string;
      plugin_id: string;
      namespace: string;
      session_id: string;
      distance: number;
    }>;
  log('\n→ KNN (no filter), top 5:');
  for (const r of knnPlain) {
    log(`   ${r.distance.toFixed(6)}  ${r.session_id}  ${r.plugin_id}/${r.namespace}  ${r.data_key}`);
  }

  // KNN: partition key filter (session) + metadata filter (plugin_id)
  const knnFiltered = db
    .prepare(`
      SELECT data_key, plugin_id, namespace, session_id, payload, distance
      FROM ${tableName}
      WHERE embedding MATCH ? AND k = 5
        AND session_id = ?
        AND plugin_id = ?
      ORDER BY distance
    `)
    .all(queryJson, 'session-A', 'core-npc-graph') as Array<{
      data_key: string;
      plugin_id: string;
      namespace: string;
      session_id: string;
      payload: string;
      distance: number;
    }>;
  log('\n→ KNN (session=session-A, plugin=core-npc-graph), top 5:');
  for (const r of knnFiltered) {
    log(`   ${r.distance.toFixed(6)}  ${r.data_key}  payload=${JSON.stringify(r.payload)}`);
  }
  const allMatch = knnFiltered.every(
    (r) => r.session_id === 'session-A' && r.plugin_id === 'core-npc-graph',
  );
  log(`   filter consistency: ${allMatch ? '✅ all rows match filter' : '❌ filter leaked'}`);

  // secondary dim sanity: create a vec_memory_f1024 too, so we confirm
  // multiple per-dimension tables can coexist
  const secondary = 'vec_memory_f1024';
  db.exec(`
    CREATE VIRTUAL TABLE ${secondary} USING vec0(
      session_id text partition key,
      embedding  float[1024]
    );
  `);
  const listRows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vec_memory_%' ORDER BY name`)
    .all() as Array<{ name: string }>;
  log(`\n✅ co-existing vec0 tables: ${listRows.map((r) => r.name).join(', ')}`);

  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.writeFileSync(LOG_FILE, logLines.join('\n') + '\n');
  console.log(`\ndumped: ${path.relative(process.cwd(), LOG_FILE)}`);

  db.close();
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
