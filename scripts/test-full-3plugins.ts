/**
 * Full API E2E: 3 plugins (narrator + char-creator + codex) — pure HTTP endpoints.
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
import { createGatewayAdapter } from '../packages/runtime/src/gateway-llm-adapter.js';
import { createSqliteStore } from '../packages/store/src/sqlite/sqlite-store.js';
import { createToolExecutor } from '../packages/runtime/src/tool-executor.js';
import { createFormTool, createChoicesTool, createNotificationTool } from '../packages/tools/src/builtin/ui-tools.js';
import { unlockCodexEntriesTool } from '../plugins-v2/core-codex/tools/unlock-codex-entries.js';
import { updateCodexEntryTool } from '../plugins-v2/core-codex/tools/update-codex-entry.js';
import type { Hono } from 'hono';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins-v2');
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

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log('🎮 Full 3-Plugin API E2E Test\n');

  // Setup
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const store = createSqliteStore(DB_PATH);

  const aiStack = createAiStack();
  const apiKeys: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.endsWith('_API_KEY') && v) apiKeys[k.replace(/_API_KEY$/, '').toLowerCase()] = v;
  }

  // Build tool executor with all tools (builtin + codex local)
  const toolExecutor = createToolExecutor({
    findTool: (name) => {
      const tools: Record<string, unknown> = {
        'create-form': createFormTool,
        'create-choices': createChoicesTool,
        'create-notification': createNotificationTool,
        'unlock-codex-entries': unlockCodexEntriesTool,
        'update-codex-entry': updateCodexEntryTool,
      };
      return tools[name] as ReturnType<typeof createFormTool> | undefined;
    },
    store,
  });

  const { app, registry } = await bootstrapV2({
    pluginsDir: PLUGINS_DIR,
    llmAdapter: createGatewayAdapter(aiStack.gateway, { apiKeys }),
    store,
  });

  // Inject toolExecutor into Hono context (add middleware before routes)
  // Since bootstrap already ran, we need to use the existing app
  // The toolExecutor needs to be part of the turn execution deps
  // For now, we'll pass it via the getConfigFn workaround
  // TODO: proper toolExecutor injection in bootstrap

  const plugins = [...registry.getAll().keys()];
  console.log(`🔌 Plugins: ${plugins.join(', ')}`);

  let passed = 0;
  let failed = 0;
  function check(label: string, ok: boolean, detail?: string) {
    if (ok) { passed++; console.log(`  ✅ ${label}`); }
    else { failed++; console.log(`  ❌ ${label}${detail ? ': ' + detail : ''}`); }
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n1️⃣  Health + Plugins');
  // ═══════════════════════════════════════════════════════════════
  const health = await api(app, 'GET', '/v2/health');
  check('health OK', health.status === 200);

  const pluginList = await api(app, 'GET', '/v2/plugins');
  const pList = (pluginList.data.plugins as Array<Record<string, unknown>>) ?? [];
  check('3 plugins loaded', pList.length === 3);
  check('narrator present', pList.some(p => p.id === 'core-narrator'));
  check('char-creator present', pList.some(p => p.id === 'core-char-creator'));
  check('codex present', pList.some(p => p.id === 'core-codex'));

  // Check plugin types
  const codexPlugin = pList.find(p => p.id === 'core-codex');
  check('codex is non-core', codexPlugin?.pluginType === 'plugin');
  const narratorPlugin = pList.find(p => p.id === 'core-narrator');
  check('narrator is core', narratorPlugin?.pluginType === 'core-plugin');

  // ═══════════════════════════════════════════════════════════════
  console.log('\n2️⃣  Create Session (all 3 plugins)');
  // ═══════════════════════════════════════════════════════════════
  const start = await api(app, 'POST', '/v2/session/start', {
    locale: 'zh-CN',
    plugins: ['core-narrator', 'core-char-creator', 'core-codex'],
  });
  check('session created', start.status === 200);
  const sid = start.data.sessionId as string;
  console.log(`  📋 Session: ${sid}`);

  // ═══════════════════════════════════════════════════════════════
  console.log('\n3️⃣  Turn 1: Opening + CharCreator + Codex');
  // ═══════════════════════════════════════════════════════════════
  const t1Start = Date.now();
  const turn1 = await api(app, 'POST', `/v2/session/${sid}/turn`, { message: '开始游戏' });
  const t1Ms = Date.now() - t1Start;
  console.log(`  ⏱  ${t1Ms}ms`);
  check('turn 1 OK', turn1.status === 200);

  const rr1 = (turn1.data.runtimeResults as Array<Record<string, unknown>>) ?? [];
  console.log(`  📊 Runtime results: ${rr1.length}`);
  for (const r of rr1) {
    const out = r.output as Record<string, unknown> | null;
    const narrative = (out?.narrativeOutput ?? out?.narrativeTemplate ?? '') as string;
    console.log(`    [${r.pluginId}] ${r.status} — ${narrative.substring(0, 80)}...`);
  }

  // Check narrator
  const n1 = rr1.find(r => r.pluginId === 'core-narrator');
  check('narrator executed', n1?.status === 'success');
  check('narrator has narrative', typeof (n1?.output as Record<string, unknown>)?.narrativeOutput === 'string');

  // Check char-creator
  const cc1 = rr1.find(r => r.pluginId === 'core-char-creator');
  check('char-creator executed', cc1?.status === 'success');
  const ccOut = cc1?.output as Record<string, unknown> | undefined;
  const hasForm = ccOut?.form && typeof (ccOut.form as Record<string, unknown>).formId === 'string';
  const hasTemplate = typeof ccOut?.narrativeTemplate === 'string';
  check('char-creator has form', !!hasForm);
  check('char-creator has template', !!hasTemplate);

  // Check codex
  const cx1 = rr1.find(r => r.pluginId === 'core-codex');
  check('codex executed', cx1?.status === 'success');

  // Check pendingInputs
  const pi = (turn1.data.pendingInputs as Array<Record<string, unknown>>) ?? [];
  check('has pendingInputs from char-creator', pi.some(p => p.pluginId === 'core-char-creator'));

  // ═══════════════════════════════════════════════════════════════
  console.log('\n4️⃣  Submit Character Form');
  // ═══════════════════════════════════════════════════════════════
  const form = ccOut?.form as Record<string, unknown> | undefined;
  const formId = (form?.formId ?? 'char-creation') as string;
  const fields = (form?.fields as Array<Record<string, unknown>>) ?? [];

  // Auto-fill form values
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
  check('submit OK', submit.status === 200);
  check('accepted', submit.data.accepted === true);
  const filled = submit.data.filledNarrative as string;
  console.log(`  📖 Filled: ${filled.substring(0, 100)}...`);

  // ═══════════════════════════════════════════════════════════════
  console.log('\n5️⃣  Turn 2: Narrator continues, codex tracks, char-creator SHOULD NOT trigger');
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
    console.log(`    [${r.pluginId}] ${r.status} — ${narrative.substring(0, 80)}...`);
  }

  const n2 = rr2.find(r => r.pluginId === 'core-narrator');
  check('narrator on turn 2', n2?.status === 'success');

  const cc2 = rr2.find(r => r.pluginId === 'core-char-creator');
  check('char-creator NOT on turn 2', cc2 === undefined);

  const cx2 = rr2.find(r => r.pluginId === 'core-codex');
  check('codex on turn 2', cx2?.status === 'success');

  const pi2 = turn2.data.pendingInputs as Array<unknown> | undefined;
  check('no pendingInputs on turn 2', !pi2 || pi2.length === 0);

  // ═══════════════════════════════════════════════════════════════
  console.log('\n6️⃣  API State Verification');
  // ═══════════════════════════════════════════════════════════════
  const session = await api(app, 'GET', `/v2/session/${sid}`);
  check('session exists', session.status === 200);
  check('turnCount = 2', session.data.turnCount === 2);

  const turns = await api(app, 'GET', `/v2/session/${sid}/turns`);
  check('2 turns in history', ((turns.data.turns as unknown[]) ?? []).length === 2);

  const latest = await api(app, 'GET', `/v2/session/${sid}/results`);
  check('latest = turn 2', latest.data.turnId === turn2.data.turnId);

  // ═══════════════════════════════════════════════════════════════
  console.log('\n7️⃣  Store Persistence Verification');
  // ═══════════════════════════════════════════════════════════════
  const allMessages = await store.listTurnMessages(sid);
  console.log(`  💬 TurnMessages: ${allMessages.length}`);
  for (const m of allMessages) {
    const tag = m.name ? `[${m.name}]` : `[${m.sourceType}]`;
    const form = m.pendingInput ? ' 📋' : '';
    console.log(`    ${m.turnId.substring(0, 8)}.. ${m.role} ${tag}: ${m.content.substring(0, 50)}...${form}`);
  }
  check('messages saved', allMessages.length >= 5); // player1 + narrator1 + charCreator1 + filled + player2 + narrator2 + codex...

  const playerInputs = await store.listPlayerInputs(sid);
  check('player input saved', playerInputs.length >= 1);
  console.log(`  📝 PlayerInputs: ${playerInputs.length}`);

  const turnResults = await store.listTurnResults(sid);
  check('turn results saved', turnResults.length === 2);
  console.log(`  🔄 TurnResults: ${turnResults.length}`);

  const toolCalls = await store.listToolCalls(sid);
  console.log(`  🔧 ToolCalls: ${toolCalls.length}`);
  for (const tc of toolCalls) {
    console.log(`    ${tc.toolName} (${tc.approvalStatus}) — ${tc.durationMs}ms`);
  }

  const runtimeResults1 = await store.listRuntimeResults(sid, turn1.data.turnId as string);
  const runtimeResults2 = await store.listRuntimeResults(sid, turn2.data.turnId as string);
  check('turn 1 runtime results persisted', runtimeResults1.length >= 2);
  check('turn 2 runtime results persisted', runtimeResults2.length >= 1);
  console.log(`  📊 RuntimeResults: turn1=${runtimeResults1.length}, turn2=${runtimeResults2.length}`);

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

main().catch((err) => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
