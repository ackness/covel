/**
 * Session resume test: play 2 turns, "shutdown", then resume and play turn 3.
 *
 * Verifies:
 * - Session state persists across "restarts"
 * - Message history loads correctly on resume
 * - Narrator continues with full context from previous turns
 * - Turn count is accurate
 *
 * Usage:
 *   npx tsx --env-file=.env --env-file=.env.llm scripts/test-session-resume.ts
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
const DB_PATH = path.join(DATA_DIR, 'session-resume-test.db');

async function api(app: Hono, method: string, url: string, body?: unknown) {
  const res = await app.request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json() as Record<string, unknown> };
}

function makeGateway() {
  const ai = createAiStack();
  const apiKeys: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.endsWith('_API_KEY') && v) apiKeys[k.replace(/_API_KEY$/, '').toLowerCase()] = v;
  }
  return createGatewayAdapter(ai.gateway, { apiKeys });
}

async function main() {
  console.log('🔄 Session Resume Test\n');

  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

  let sessionId: string;

  // ══════════════════════════════════════════════════════════
  // Phase 1: First boot — create session, play 2 turns
  // ══════════════════════════════════════════════════════════
  console.log('═══ Phase 1: First boot ═══\n');

  {
    const store = createSqliteStore(DB_PATH);
    const { app } = await bootstrapV2({
      pluginsDir: PLUGINS_DIR,
      llmAdapter: makeGateway(),
      store,
    });

    // Create session
    const start = await api(app, 'POST', '/v2/session/start', {
      plugins: ['core-narrator'],
    });
    sessionId = start.data.sessionId as string;
    console.log(`📋 Session: ${sessionId}`);

    // Turn 1
    const t1 = await api(app, 'POST', `/v2/session/${sessionId}/turn`, {
      message: '我站在一座古老的城堡前，城门紧闭',
    });
    const n1 = ((t1.data.runtimeResults as Array<Record<string, unknown>>)?.[0]?.output as Record<string, unknown>)?.narrativeOutput as string;
    console.log(`\n🎮 Turn 1: ${n1?.substring(0, 100)}...`);

    // Turn 2
    const t2 = await api(app, 'POST', `/v2/session/${sessionId}/turn`, {
      message: '我推开城门走了进去',
    });
    const n2 = ((t2.data.runtimeResults as Array<Record<string, unknown>>)?.[0]?.output as Record<string, unknown>)?.narrativeOutput as string;
    console.log(`🎮 Turn 2: ${n2?.substring(0, 100)}...`);

    // Check state before "shutdown"
    const session = await api(app, 'GET', `/v2/session/${sessionId}`);
    console.log(`\n📊 Before shutdown: turnCount=${session.data.turnCount}`);

    const msgs = await store.listTurnMessages(sessionId);
    console.log(`💬 Messages in DB: ${msgs.length}`);

    // "Shutdown" — close the store
    await store.close();
    console.log('🔌 Store closed (simulating shutdown)\n');
  }

  // ══════════════════════════════════════════════════════════
  // Phase 2: Second boot — resume and play turn 3
  // ══════════════════════════════════════════════════════════
  console.log('═══ Phase 2: Resume ═══\n');

  {
    // Re-open the SAME database
    const store = createSqliteStore(DB_PATH);
    const { app } = await bootstrapV2({
      pluginsDir: PLUGINS_DIR,
      llmAdapter: makeGateway(),
      store,
    });

    // Verify session still exists
    const session = await api(app, 'GET', `/v2/session/${sessionId}`);
    console.log(`📋 Session found: ${session.status === 200 ? 'YES' : 'NO'}`);
    console.log(`📊 turnCount: ${session.data.turnCount}`);

    // Verify message history loaded
    const msgs = await store.listTurnMessages(sessionId);
    console.log(`💬 Messages in DB: ${msgs.length}`);

    // Verify turn history via API
    const turns = await api(app, 'GET', `/v2/session/${sessionId}/turns`);
    const turnList = (turns.data.turns as Array<Record<string, unknown>>) ?? [];
    console.log(`🔄 Turn history: ${turnList.length} turns`);

    // Play Turn 3 — narrator should have full context from turns 1-2
    console.log('\n🎮 Turn 3: "我探索城堡内部，寻找线索"');
    const t3Start = Date.now();
    const t3 = await api(app, 'POST', `/v2/session/${sessionId}/turn`, {
      message: '我探索城堡内部，寻找线索',
    });
    const t3Ms = Date.now() - t3Start;
    const n3 = ((t3.data.runtimeResults as Array<Record<string, unknown>>)?.[0]?.output as Record<string, unknown>)?.narrativeOutput as string;
    console.log(`📖 (${t3Ms}ms):`);
    console.log(n3?.substring(0, 300) + '...');

    // Final state check
    const finalSession = await api(app, 'GET', `/v2/session/${sessionId}`);
    const finalMsgs = await store.listTurnMessages(sessionId);
    const finalTurns = await api(app, 'GET', `/v2/session/${sessionId}/turns`);

    console.log('\n' + '═'.repeat(60));
    console.log('🔍 Final Verification');
    console.log('═'.repeat(60));

    let passed = 0;
    let failed = 0;
    function check(label: string, ok: boolean) {
      if (ok) { passed++; console.log(`  ✅ ${label}`); }
      else { failed++; console.log(`  ❌ ${label}`); }
    }

    check('session persisted', finalSession.status === 200);
    check('turnCount = 3', finalSession.data.turnCount === 3);
    check('3 turns in history', ((finalTurns.data.turns as unknown[]) ?? []).length === 3);
    check('messages accumulated', finalMsgs.length >= 6); // 3 players + 3 narrators minimum
    check('turn 3 success', t3.status === 200);
    check('narrator produced output', typeof n3 === 'string' && n3.length > 50);

    // Check narrative continuity — turn 3 should reference the castle
    const mentionsCastle = n3?.includes('城堡') || n3?.includes('城') || n3?.includes('门') || n3?.includes('大厅');
    check('narrative continuity (mentions castle context)', !!mentionsCastle);

    await store.close();

    console.log(`\n📊 Results: ${passed}/${passed + failed} passed`);
    console.log(`💾 DB: ${(fs.statSync(DB_PATH).size / 1024).toFixed(1)} KB`);
    if (failed > 0) process.exit(1);
  }
}

main().catch((err) => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
