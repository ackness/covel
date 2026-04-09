/**
 * Pure API test — only uses HTTP endpoints, no direct function calls.
 *
 * Tests the complete game flow as a real client would use it:
 *   1. POST /v2/session/start
 *   2. POST /v2/session/:id/turn  (narrator + char-creator)
 *   3. POST /v2/session/:id/submit-inputs  (player fills form)
 *   4. POST /v2/session/:id/turn  (narrator continues with character)
 *   5. GET  /v2/session/:id/turns (verify history)
 *   6. GET  /v2/session/:id       (verify session state)
 *   7. GET  /v2/plugins            (list plugins)
 *   8. GET  /v2/health
 *
 * Usage:
 *   npx tsx --env-file=.env --env-file=.env.llm scripts/test-pure-api.ts
 */

import path from 'node:path';
import fs from 'node:fs';
import { bootstrapV2 } from '../apps/server/src/routes/v2/bootstrap.js';
import { createAiStack } from '../apps/server/src/ai-setup.js';
import { createGatewayAdapter } from '../packages/runtime/src/gateway-llm-adapter.js';
import { createSqliteStore } from '../packages/store/src/sqlite/sqlite-store.js';
import type { Hono } from 'hono';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'pure-api-test.db');

// ── HTTP helper ──────────────────────────────────────────────────

async function api(app: Hono, method: string, path: string, body?: unknown) {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await app.request(path, opts);
  const data = await res.json();
  return { status: res.status, data: data as Record<string, unknown> };
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log('🌐 Pure API E2E Test\n');

  // Setup (only infra, no direct module calls after this)
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

  const store = createSqliteStore(DB_PATH);
  const aiStack = createAiStack();
  const apiKeys: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.endsWith('_API_KEY') && v) apiKeys[k.replace(/_API_KEY$/, '').toLowerCase()] = v;
  }

  const { app } = await bootstrapV2({
    pluginsDir: PLUGINS_DIR,
    llmAdapter: createGatewayAdapter(aiStack.gateway, { apiKeys }),
    store,
  });

  let passed = 0;
  let failed = 0;

  function check(label: string, ok: boolean, detail?: string) {
    if (ok) { passed++; console.log(`  ✅ ${label}`); }
    else { failed++; console.log(`  ❌ ${label}${detail ? ': ' + detail : ''}`); }
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('1️⃣  GET /v2/health');
  // ═══════════════════════════════════════════════════════════════
  const health = await api(app, 'GET', '/v2/health');
  check('status 200', health.status === 200);
  check('status: ok', health.data.status === 'ok');

  // ═══════════════════════════════════════════════════════════════
  console.log('\n2️⃣  GET /v2/plugins');
  // ═══════════════════════════════════════════════════════════════
  const plugins = await api(app, 'GET', '/v2/plugins');
  check('status 200', plugins.status === 200);
  const pluginList = (plugins.data.plugins as Array<Record<string, unknown>>) ?? [];
  check('has plugins', pluginList.length >= 2);
  check('has narrator', pluginList.some(p => p.id === 'core-narrator'));
  check('has char-creator', pluginList.some(p => p.id === 'core-char-creator'));

  // ═══════════════════════════════════════════════════════════════
  console.log('\n3️⃣  POST /v2/session/start');
  // ═══════════════════════════════════════════════════════════════
  const start = await api(app, 'POST', '/v2/session/start', {
    locale: 'zh-CN',
    plugins: ['core-narrator', 'core-char-creator'],
  });
  check('status 200', start.status === 200);
  check('has sessionId', typeof start.data.sessionId === 'string');
  const sessionId = start.data.sessionId as string;
  console.log(`  📋 sessionId: ${sessionId}`);

  // ═══════════════════════════════════════════════════════════════
  console.log('\n4️⃣  POST /v2/session/:id/turn (Turn 1: opening + char form)');
  // ═══════════════════════════════════════════════════════════════
  const t1Start = Date.now();
  const turn1 = await api(app, 'POST', `/v2/session/${sessionId}/turn`, {
    message: '开始游戏',
  });
  console.log(`  ⏱  ${Date.now() - t1Start}ms`);
  check('status 200', turn1.status === 200);
  check('has turnId', typeof turn1.data.turnId === 'string');

  const rr1 = (turn1.data.runtimeResults as Array<Record<string, unknown>>) ?? [];
  check('has runtime results', rr1.length >= 1);

  const narrator1 = rr1.find(r => r.pluginId === 'core-narrator');
  check('narrator success', narrator1?.status === 'success');
  const narratorOutput = (narrator1?.output as Record<string, unknown>)?.narrativeOutput;
  check('narrator has narrative', typeof narratorOutput === 'string' && (narratorOutput as string).length > 50);
  if (narratorOutput) console.log(`  📖 Narrator: ${(narratorOutput as string).substring(0, 100)}...`);

  const charCreator1 = rr1.find(r => r.pluginId === 'core-char-creator');
  check('char-creator success', charCreator1?.status === 'success');
  const charOutput = charCreator1?.output as Record<string, unknown> | undefined;
  check('has narrativeTemplate', typeof charOutput?.narrativeTemplate === 'string');
  check('has form', typeof (charOutput?.form as Record<string, unknown>)?.formId === 'string');

  const pendingInputs = (turn1.data.pendingInputs as Array<Record<string, unknown>>) ?? [];
  check('has pendingInputs', pendingInputs.length > 0);

  const form = charOutput?.form as Record<string, unknown>;
  const formId = form?.formId as string;
  const fields = (form?.fields as Array<Record<string, unknown>>) ?? [];
  if (form) {
    console.log(`  🎭 Form: ${form.title} (${fields.length} fields)`);
    for (const f of fields) console.log(`     [${f.type}] ${f.name}: ${f.label}`);
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n5️⃣  POST /v2/session/:id/submit-inputs');
  // ═══════════════════════════════════════════════════════════════
  // Build values from the form fields dynamically
  const playerValues: Record<string, string> = {};
  for (const f of fields) {
    const name = f.name as string;
    const options = f.options as string[] | undefined;
    if (name.toLowerCase().includes('name') || name.toLowerCase().includes('名')) {
      playerValues[name] = '林清风';
    } else if (options && options.length > 0) {
      playerValues[name] = options[0]; // Pick first option
    } else {
      playerValues[name] = 'test-value';
    }
  }
  console.log(`  📝 Values: ${JSON.stringify(playerValues)}`);

  const submit = await api(app, 'POST', `/v2/session/${sessionId}/submit-inputs`, {
    turnId: turn1.data.turnId,
    formId,
    values: playerValues,
  });
  check('status 200', submit.status === 200);
  check('accepted', submit.data.accepted === true);
  check('has filledNarrative', typeof submit.data.filledNarrative === 'string');
  if (submit.data.filledNarrative) {
    console.log(`  📖 Filled: ${(submit.data.filledNarrative as string).substring(0, 100)}...`);
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n6️⃣  POST /v2/session/:id/turn (Turn 2: narrator continues)');
  // ═══════════════════════════════════════════════════════════════
  const t2Start = Date.now();
  const turn2 = await api(app, 'POST', `/v2/session/${sessionId}/turn`, {
    message: '我环顾四周，试图回忆起更多的事情',
  });
  console.log(`  ⏱  ${Date.now() - t2Start}ms`);
  check('status 200', turn2.status === 200);

  const rr2 = (turn2.data.runtimeResults as Array<Record<string, unknown>>) ?? [];
  const narrator2 = rr2.find(r => r.pluginId === 'core-narrator');
  check('narrator success', narrator2?.status === 'success');

  // char-creator should NOT trigger on turn 2
  const charCreator2 = rr2.find(r => r.pluginId === 'core-char-creator');
  check('char-creator NOT triggered on turn 2', charCreator2 === undefined);

  const narrative2 = (narrator2?.output as Record<string, unknown>)?.narrativeOutput as string;
  check('narrator has content', typeof narrative2 === 'string' && narrative2.length > 50);
  if (narrative2) console.log(`  📖 Narrator: ${narrative2.substring(0, 150)}...`);

  // Check no pendingInputs on turn 2
  const pi2 = turn2.data.pendingInputs as Array<unknown> | undefined;
  check('no pendingInputs on turn 2', !pi2 || pi2.length === 0);

  // ═══════════════════════════════════════════════════════════════
  console.log('\n7️⃣  GET /v2/session/:id/turns (history)');
  // ═══════════════════════════════════════════════════════════════
  const history = await api(app, 'GET', `/v2/session/${sessionId}/turns`);
  check('status 200', history.status === 200);
  const turns = (history.data.turns as Array<Record<string, unknown>>) ?? [];
  check('has 2 turns', turns.length === 2);

  // ═══════════════════════════════════════════════════════════════
  console.log('\n8️⃣  GET /v2/session/:id');
  // ═══════════════════════════════════════════════════════════════
  const session = await api(app, 'GET', `/v2/session/${sessionId}`);
  check('status 200', session.status === 200);
  check('turnCount = 2', session.data.turnCount === 2);

  // ═══════════════════════════════════════════════════════════════
  console.log('\n9️⃣  GET /v2/session/:id/results (latest turn)');
  // ═══════════════════════════════════════════════════════════════
  const latest = await api(app, 'GET', `/v2/session/${sessionId}/results`);
  check('status 200', latest.status === 200);
  check('is turn 2', latest.data.turnId === turn2.data.turnId);

  // ═══════════════════════════════════════════════════════════════
  console.log('\n🔟  Error cases');
  // ═══════════════════════════════════════════════════════════════
  const notFound = await api(app, 'POST', '/v2/session/nonexistent/turn', { message: 'test' });
  check('404 for unknown session', notFound.status === 404);

  const badSubmit = await api(app, 'POST', `/v2/session/${sessionId}/submit-inputs`, {});
  check('400 for missing fields', badSubmit.status === 400);

  // ═══════════════════════════════════════════════════════════════
  await store.close();
  const dbSize = fs.statSync(DB_PATH).size;

  console.log('\n' + '═'.repeat(60));
  console.log(`📊 Results: ${passed} passed, ${failed} failed`);
  console.log(`💾 DB: ${(dbSize / 1024).toFixed(1)} KB`);
  console.log('═'.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
