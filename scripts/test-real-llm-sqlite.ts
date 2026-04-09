/**
 * Real LLM + SQLite persistence test.
 *
 * Tests the complete flow with data persisted to SQLite.
 * After turns, queries the store to verify data was saved.
 *
 * Usage:
 *   npx tsx --env-file=.env --env-file=.env.llm scripts/test-real-llm-sqlite.ts
 */

import path from 'node:path';
import fs from 'node:fs';
import { bootstrapV2 } from '../apps/server/src/routes/v2/bootstrap.js';
import { createAiStack } from '../apps/server/src/ai-setup.js';
import { createGatewayAdapter } from '../packages/runtime/src/gateway-llm-adapter.js';
import { createSqliteStore } from '../packages/store/src/sqlite/sqlite-store.js';

const PLUGINS_DIR = path.resolve(import.meta.dirname, '../plugins');
const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const DB_PATH = path.join(DATA_DIR, 'test-e2e.db');

async function main() {
  console.log('🚀 Real LLM + SQLite persistence test\n');

  // Ensure data/ dir exists
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Clean previous test DB
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
  }

  // 1. Create SQLite store
  const store = createSqliteStore(DB_PATH);
  console.log(`💾 SQLite store: ${DB_PATH}`);

  // 2. Init AI stack
  const aiStack = createAiStack();
  const apiKeys: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.endsWith('_API_KEY') && value) {
      apiKeys[key.replace(/_API_KEY$/, '').toLowerCase()] = value;
    }
  }
  const llm = createGatewayAdapter(aiStack.gateway, { apiKeys });

  // 3. Bootstrap
  const { app, registry } = await bootstrapV2({
    pluginsDir: PLUGINS_DIR,
    llmAdapter: llm,
    store,
  });

  console.log(`✅ Bootstrapped. Plugins: ${[...registry.getAll().keys()].join(', ')}\n`);

  // 4. Start session
  const startRes = await app.request('/v2/session/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locale: 'zh-CN', plugins: ['core-narrator'] }),
  });
  const { sessionId } = await startRes.json() as { sessionId: string };
  console.log(`📋 Session: ${sessionId}\n`);

  // 5. Turn 1
  console.log('─'.repeat(60));
  console.log('🎮 Turn 1: "我走进了一座废弃的图书馆"');
  console.log('─'.repeat(60));

  const t1 = Date.now();
  const turn1Res = await app.request(`/v2/session/${sessionId}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '我走进了一座废弃的图书馆' }),
  });
  const turn1 = await turn1Res.json() as {
    turnId: string;
    runtimeResults: Array<{ pluginId: string; status: string; output: { narrativeOutput?: string } | null }>;
  };
  console.log(`\n📖 (${Date.now() - t1}ms):`);
  console.log(turn1.runtimeResults[0]?.output?.narrativeOutput ?? '(no output)');

  // 6. Turn 2
  console.log('\n' + '─'.repeat(60));
  console.log('🎮 Turn 2: "我翻开桌上那本发光的古书"');
  console.log('─'.repeat(60));

  const t2 = Date.now();
  const turn2Res = await app.request(`/v2/session/${sessionId}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '我翻开桌上那本发光的古书' }),
  });
  const turn2 = await turn2Res.json() as typeof turn1;
  console.log(`\n📖 (${Date.now() - t2}ms):`);
  console.log(turn2.runtimeResults[0]?.output?.narrativeOutput ?? '(no output)');

  // 7. Verify persistence — query store directly
  console.log('\n' + '═'.repeat(60));
  console.log('🔍 Verifying SQLite persistence...');
  console.log('═'.repeat(60));

  const savedSession = await store.getSession(sessionId);
  console.log(`\n  Session: ${savedSession ? 'FOUND' : 'MISSING'} (phase: ${savedSession?.phase}, turns: ${savedSession?.turnCount})`);

  const savedTurns = await store.listTurnResults(sessionId);
  console.log(`  Turn results: ${savedTurns.length} saved`);

  const savedRuntimes = await store.listRuntimeResults(sessionId, turn1.turnId);
  console.log(`  Runtime results (turn 1): ${savedRuntimes.length} saved`);

  const savedRuntimes2 = await store.listRuntimeResults(sessionId, turn2.turnId);
  console.log(`  Runtime results (turn 2): ${savedRuntimes2.length} saved`);

  // 8. Verify via API
  const historyRes = await app.request(`/v2/session/${sessionId}/turns`);
  const history = await historyRes.json() as { turns: Array<{ turnId: string }> };
  console.log(`  Turn history (API): ${history.turns.length} turns`);

  const sessionRes = await app.request(`/v2/session/${sessionId}`);
  const sessionData = await sessionRes.json() as { turnCount: number; phase: string };
  console.log(`  Session (API): turnCount=${sessionData.turnCount}, phase=${sessionData.phase}`);

  // 9. Verify DB file exists and has data
  const dbSize = fs.statSync(DB_PATH).size;
  console.log(`\n  📁 DB file size: ${(dbSize / 1024).toFixed(1)} KB`);

  // Close store
  await store.close();

  // Summary
  const allGood = savedSession && savedTurns.length === 2 && savedRuntimes.length >= 1 && savedRuntimes2.length >= 1;
  console.log('\n' + '═'.repeat(60));
  if (allGood) {
    console.log('✅ All data persisted to SQLite successfully!');
  } else {
    console.log('❌ Some data missing from SQLite!');
  }
  console.log('═'.repeat(60));
}

main().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
