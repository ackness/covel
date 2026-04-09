/**
 * Full API E2E: 3 plugins (narrator + char-creator + codex) — pure HTTP endpoints.
 *
 * Tests the complete framework orchestration pipeline:
 *   bootstrapV2 → plugin discovery → tool auto-loading → approval pipeline
 *   → HTTP API → TurnExecutor (trigger → schedule → context → LLM → tool loop → result)
 *
 * Flow:
 *   Turn 1: narrator opening + char-creator form + codex discovers knowledge
 *   Submit: player fills character form
 *   Turn 2: narrator continues with character info, codex tracks new discoveries
 *   Verify: all data persisted, message history complete
 *
 * Usage:
 *   npx tsx --env-file=.env --env-file=.env.llm scripts/test-full-3plugins.ts
 */

import path from 'node:path';
import fs from 'node:fs';
import { bootstrapV2 } from '../apps/server/src/routes/v2/bootstrap.js';
import { createAiStack } from '../apps/server/src/ai-setup.js';
import { createGatewayAdapter } from '../packages/runtime/src/index.js';
import { createSqliteStore } from '../packages/store/src/index.js';
import type { DataStore } from '../packages/store/src/index.js';
import type { Hono } from 'hono';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'full-3plugins-test.db');

// ── HTTP helper ──────────────────────────────────────────────────

async function api(app: Hono, method: string, url: string, body?: unknown) {
  const res = await app.request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json() as Record<string, unknown> };
}

// ── Test runner ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ': ' + detail : ''}`); }
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log('🎮 Full 3-Plugin E2E — Framework Orchestration Pipeline\n');

  // ── Setup: only provide store + LLM adapter, everything else through bootstrap ──
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const store = createSqliteStore(DB_PATH);

  const aiStack = createAiStack();
  const apiKeys: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.endsWith('_API_KEY') && v) apiKeys[k.replace(/_API_KEY$/, '').toLowerCase()] = v;
  }

  // Bootstrap: framework handles plugin discovery, tool loading, approval, and wiring
  const { app, registry } = await bootstrapV2({
    pluginsDir: PLUGINS_DIR,
    llmAdapter: createGatewayAdapter(aiStack.gateway, { apiKeys }),
    store,
  });

  const plugins = [...registry.getAll().keys()];
  console.log(`🔌 Plugins discovered by bootstrap: ${plugins.join(', ')}`);

  // ═══════════════════════════════════════════════════════════════
  console.log('\n1️⃣  Health + Plugin Discovery (bootstrap auto-discovered)');
  // ═══════════════════════════════════════════════════════════════
  const health = await api(app, 'GET', '/v2/health');
  check('health OK', health.status === 200);

  const pluginList = await api(app, 'GET', '/v2/plugins');
  const pList = (pluginList.data.plugins as Array<Record<string, unknown>>) ?? [];
  check('4 plugins auto-discovered', pList.length === 4);
  check('pregame present', pList.some(p => p.id === 'core-pregame'));
  check('narrator present', pList.some(p => p.id === 'core-narrator'));
  check('char-creator present', pList.some(p => p.id === 'core-char-creator'));
  check('codex present', pList.some(p => p.id === 'core-codex'));

  // Verify plugin metadata from PLUGIN.md frontmatter
  const codexPlugin = pList.find(p => p.id === 'core-codex');
  check('codex is non-core (pluginType from frontmatter)', codexPlugin?.pluginType === 'plugin');
  const narratorPlugin = pList.find(p => p.id === 'core-narrator');
  check('narrator is core-plugin', narratorPlugin?.pluginType === 'core-plugin');

  // ═══════════════════════════════════════════════════════════════
  console.log('\n2️⃣  Create Session');
  // ═══════════════════════════════════════════════════════════════
  const start = await api(app, 'POST', '/v2/session/start', {
    locale: 'zh-CN',
    plugins: ['core-pregame', 'core-narrator', 'core-char-creator', 'core-codex'],
  });
  check('session created', start.status === 200);
  const sid = start.data.sessionId as string;
  console.log(`  📋 Session: ${sid}`);

  // ═══════════════════════════════════════════════════════════════
  console.log('\n3️⃣  Turn 1: Orchestration Pipeline (trigger → schedule → context → LLM → tools)');
  // ═══════════════════════════════════════════════════════════════
  const t1Start = Date.now();
  const turn1 = await api(app, 'POST', `/v2/session/${sid}/turn`, { message: '开始游戏' });
  const t1Ms = Date.now() - t1Start;
  console.log(`  ⏱  ${t1Ms}ms`);
  check('turn 1 OK', turn1.status === 200);

  const rr1 = (turn1.data.runtimeResults as Array<Record<string, unknown>>) ?? [];
  console.log(`  📊 Runtime results: ${rr1.length} (ordered by priority scheduler)`);
  for (const r of rr1) {
    const out = r.output as Record<string, unknown> | null;
    const narrative = (out?.narrativeOutput ?? out?.narrativeTemplate ?? '') as string;
    console.log(`    [p=${r.priority ?? '?'}] ${r.pluginId} — ${r.status} — ${narrative.substring(0, 60)}...`);
  }

  // Verify priority order: pregame(0) → narrator(500) → codex(650) → char-creator(700)
  const rr1Ids = rr1.map(r => r.pluginId);
  const pregameIdx = rr1Ids.indexOf('core-pregame');
  const narratorIdx = rr1Ids.indexOf('core-narrator');
  const codexIdx = rr1Ids.indexOf('core-codex');
  const charIdx = rr1Ids.indexOf('core-char-creator');
  check('priority order: pregame first', pregameIdx === 0);
  check('priority order: narrator before codex', narratorIdx < codexIdx);
  check('priority order: codex before char-creator', codexIdx < charIdx);

  // Pregame executed (trigger: scheduled, first turn, priority 0)
  const pg1 = rr1.find(r => r.pluginId === 'core-pregame');
  check('pregame triggered (scheduled, turn 1)', pg1?.status === 'success');
  check('pregame produced narrativeOutput', typeof (pg1?.output as Record<string, unknown>)?.narrativeOutput === 'string');

  // Narrator executed (trigger: auto)
  const n1 = rr1.find(r => r.pluginId === 'core-narrator');
  check('narrator triggered (auto)', n1?.status === 'success');
  check('narrator produced narrativeOutput', typeof (n1?.output as Record<string, unknown>)?.narrativeOutput === 'string');

  // Char-creator executed (trigger: scheduled, first turn)
  const cc1 = rr1.find(r => r.pluginId === 'core-char-creator');
  check('char-creator triggered (scheduled, turn 1)', cc1?.status === 'success');
  const ccOut = cc1?.output as Record<string, unknown> | undefined;
  check('char-creator used create-form tool (auto-allowed by approval)', !!ccOut?.form);
  check('char-creator has narrativeTemplate', typeof ccOut?.narrativeTemplate === 'string');

  // Codex executed (trigger: auto)
  const cx1 = rr1.find(r => r.pluginId === 'core-codex');
  check('codex triggered (auto)', cx1?.status === 'success');

  // Char-creator injected narrator output via input.inject
  const pi = (turn1.data.pendingInputs as Array<Record<string, unknown>>) ?? [];
  check('pendingInputs from char-creator (form submission needed)', pi.some(p => p.pluginId === 'core-char-creator'));

  // ═══════════════════════════════════════════════════════════════
  console.log('\n4️⃣  Submit Character Form');
  // ═══════════════════════════════════════════════════════════════
  const form = ccOut?.form as Record<string, unknown> | undefined;
  const formId = (form?.formId ?? 'char-creation') as string;
  const fields = (form?.fields as Array<Record<string, unknown>>) ?? [];

  const values: Record<string, string> = {};
  for (const f of fields) {
    const name = f.name as string;
    const opts = f.options as string[] | undefined;
    if (name.toLowerCase().includes('name') || name.toLowerCase().includes('名')) {
      values[name] = '林清风';
    } else if (opts && opts.length > 0) {
      values[name] = opts[0];
    } else {
      values[name] = 'test';
    }
  }
  console.log(`  📝 Form: ${formId} (${fields.length} fields)`);
  console.log(`  📝 Values: ${JSON.stringify(values)}`);

  const submit = await api(app, 'POST', `/v2/session/${sid}/submit-inputs`, {
    turnId: turn1.data.turnId,
    formId,
    values,
  });
  check('form submission accepted', submit.status === 200 && submit.data.accepted === true);
  const filled = submit.data.filledNarrative as string;
  check('narrativeTemplate filled with player values', filled.includes('林清风'));
  console.log(`  📖 Filled: ${filled.substring(0, 100)}...`);

  // ═══════════════════════════════════════════════════════════════
  console.log('\n5️⃣  Turn 2: Trigger Filtering (char-creator should NOT fire)');
  // ═══════════════════════════════════════════════════════════════
  const t2Start = Date.now();
  const turn2 = await api(app, 'POST', `/v2/session/${sid}/turn`, {
    message: '我环顾四周，试图了解这个地方',
  });
  const t2Ms = Date.now() - t2Start;
  console.log(`  ⏱  ${t2Ms}ms`);
  check('turn 2 OK', turn2.status === 200);

  const rr2 = (turn2.data.runtimeResults as Array<Record<string, unknown>>) ?? [];
  console.log(`  📊 Runtime results: ${rr2.length}`);
  for (const r of rr2) {
    const out = r.output as Record<string, unknown> | null;
    const narrative = (out?.narrativeOutput ?? '') as string;
    console.log(`    [${r.pluginId}] ${r.status} — ${narrative.substring(0, 60)}...`);
  }

  check('narrator on turn 2 (auto trigger)', rr2.some(r => r.pluginId === 'core-narrator' && r.status === 'success'));
  check('codex on turn 2 (auto trigger)', rr2.some(r => r.pluginId === 'core-codex' && r.status === 'success'));
  check('pregame NOT on turn 2 (maxTriggerCount=1 enforced)', !rr2.some(r => r.pluginId === 'core-pregame'));
  check('char-creator NOT on turn 2 (maxTriggerCount=1 enforced)', !rr2.some(r => r.pluginId === 'core-char-creator'));

  const pi2 = turn2.data.pendingInputs as Array<unknown> | undefined;
  check('no pendingInputs on turn 2', !pi2 || pi2.length === 0);

  // ═══════════════════════════════════════════════════════════════
  console.log('\n6️⃣  API State Verification');
  // ═══════════════════════════════════════════════════════════════
  const session = await api(app, 'GET', `/v2/session/${sid}`);
  check('session persisted', session.status === 200);
  check('turnCount = 2', session.data.turnCount === 2);

  const turns = await api(app, 'GET', `/v2/session/${sid}/turns`);
  check('2 turn results in history', ((turns.data.turns as unknown[]) ?? []).length === 2);

  const latest = await api(app, 'GET', `/v2/session/${sid}/results`);
  check('latest results = turn 2', latest.data.turnId === turn2.data.turnId);

  // ═══════════════════════════════════════════════════════════════
  console.log('\n7️⃣  Store Persistence (DataStore contract verification)');
  // ═══════════════════════════════════════════════════════════════
  await verifyStore(store, sid, turn1.data.turnId as string, turn2.data.turnId as string);

  // ═══════════════════════════════════════════════════════════════
  await store.close();
  const dbSize = fs.statSync(DB_PATH).size;

  console.log('\n' + '═'.repeat(60));
  console.log(`📊 Results: ${passed} passed, ${failed} failed`);
  console.log(`💾 DB: ${(dbSize / 1024).toFixed(1)} KB`);
  console.log(`⏱  Total LLM time: ~${((t1Ms + t2Ms) / 1000).toFixed(1)}s`);
  console.log('═'.repeat(60));

  if (failed > 0) process.exit(1);
}

async function verifyStore(store: DataStore, sid: string, turnId1: string, turnId2: string) {
  const allMessages = await store.listTurnMessages(sid);
  console.log(`  💬 TurnMessages: ${allMessages.length}`);
  for (const m of allMessages) {
    const tag = m.name ? `[${m.name}]` : `[${m.sourceType}]`;
    const form = m.pendingInput ? ' 📋' : '';
    console.log(`    ${m.turnId.substring(0, 8)}.. ${m.role} ${tag}: ${m.content.substring(0, 50)}...${form}`);
  }
  check('messages persisted (>=5: player + narrator + codex + charCreator + filled)', allMessages.length >= 5);

  const playerInputs = await store.listPlayerInputs(sid);
  check('player form input persisted', playerInputs.length >= 1);
  console.log(`  📝 PlayerInputs: ${playerInputs.length}`);

  const turnResults = await store.listTurnResults(sid);
  check('turn results persisted (2 turns)', turnResults.length === 2);
  console.log(`  🔄 TurnResults: ${turnResults.length}`);

  const toolCalls = await store.listToolCalls(sid);
  console.log(`  🔧 ToolCalls: ${toolCalls.length}`);
  for (const tc of toolCalls) {
    console.log(`    ${tc.toolName} (${tc.approvalStatus}) — ${tc.durationMs}ms`);
  }
  check('tool calls recorded with approval status', toolCalls.every(tc => tc.approvalStatus === 'auto-allowed'));

  const rr1 = await store.listRuntimeResults(sid, turnId1);
  const rr2 = await store.listRuntimeResults(sid, turnId2);
  check('turn 1 runtime results persisted (>=2)', rr1.length >= 2);
  check('turn 2 runtime results persisted (>=1)', rr2.length >= 1);
  console.log(`  📊 RuntimeResults: turn1=${rr1.length}, turn2=${rr2.length}`);
}

main().catch((err) => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
