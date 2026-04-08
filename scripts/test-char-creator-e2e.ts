/**
 * E2E test: Narrator + CharCreator + Player Submit + Narrator continuation.
 *
 * Flow:
 *   Turn 1: narrator (p=500) → opening scene
 *           char-creator (p=700) → narrative template + form
 *   Player submits form → filled narrative saved
 *   Turn 2: narrator sees filled narrative in history → continues story with character info
 *
 * Usage:
 *   npx tsx --env-file=.env --env-file=.env.llm scripts/test-char-creator-e2e.ts
 */

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parse: parseYaml } = require('yaml') as { parse: (s: string) => Record<string, unknown> };

import { bootstrapV2 } from '../apps/server/src/routes/v2/bootstrap.js';
import { createAiStack } from '../apps/server/src/ai-setup.js';
import { createGatewayAdapter } from '../packages/runtime/src/gateway-llm-adapter.js';
import { createSqliteStore } from '../packages/store/src/sqlite/sqlite-store.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins-v2');
const WORLDS_DIR = path.join(ROOT, 'worlds');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'char-creator-e2e.db');

function loadWorld(worldId: string) {
  const worldDir = path.join(WORLDS_DIR, worldId);
  const manifest = parseYaml(fs.readFileSync(path.join(worldDir, 'world.yaml'), 'utf-8'));
  let lore = '';
  for (const f of ['WORLD.zh.md', 'WORLD.zh-CN.md', 'WORLD.md']) {
    const p = path.join(worldDir, f);
    if (fs.existsSync(p)) { lore = fs.readFileSync(p, 'utf-8'); break; }
  }
  return { manifest, lore };
}

async function main() {
  console.log('🎭 E2E: Narrator + CharCreator + Player Submit\n');

  // Setup
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const store = createSqliteStore(DB_PATH);

  const aiStack = createAiStack();
  const apiKeys: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.endsWith('_API_KEY') && value) {
      apiKeys[key.replace(/_API_KEY$/, '').toLowerCase()] = value;
    }
  }
  const llm = createGatewayAdapter(aiStack.gateway, { apiKeys });

  const { manifest: worldManifest, lore } = loadWorld('cloudmere');
  const dimensions = (worldManifest.dimensions ?? {}) as Record<string, unknown>;
  const worldContext = {
    lore: lore || String(worldManifest.summary ?? ''),
    dimensions: JSON.stringify(dimensions, null, 2).substring(0, 4000),
    openingScenario: (dimensions.startingConditions as Record<string, unknown>)?.openingScenario ?? '',
    tone: ((dimensions.tone as Record<string, unknown>)?.narrativeStyle ?? '') as string,
  };

  const { app, registry } = await bootstrapV2({
    pluginsDir: PLUGINS_DIR,
    llmAdapter: llm,
    store,
  });

  console.log(`🔌 Plugins: ${[...registry.getAll().keys()].join(', ')}`);

  // Create session
  const startRes = await app.request('/v2/session/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locale: 'zh-CN', plugins: ['core-narrator', 'core-char-creator'] }),
  });
  const { sessionId } = await startRes.json() as { sessionId: string };
  console.log(`📋 Session: ${sessionId}\n`);

  // ═══ Turn 1: Narrator + CharCreator ═══
  console.log('═'.repeat(60));
  console.log('🎮 Turn 1: 开场 + 角色创建');
  console.log('═'.repeat(60));

  const t1 = Date.now();
  const turn1Res = await app.request(`/v2/session/${sessionId}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '开始游戏' }),
  });
  const turn1 = await turn1Res.json() as {
    turnId: string;
    runtimeResults: Array<{
      pluginId: string; status: string;
      output: Record<string, unknown> | null;
    }>;
    pendingInputs?: Array<{
      pluginId: string; form: Record<string, unknown>;
      narrativeTemplate?: string;
    }>;
  };
  console.log(`(${Date.now() - t1}ms)\n`);

  // Show narrator output
  const narratorResult = turn1.runtimeResults.find(r => r.pluginId === 'core-narrator');
  if (narratorResult?.output) {
    console.log('📖 Narrator:');
    console.log(String(narratorResult.output.narrativeOutput ?? '(no output)').substring(0, 300) + '...\n');
  }

  // Show char-creator output
  const charResult = turn1.runtimeResults.find(r => r.pluginId === 'core-char-creator');
  if (charResult?.output) {
    console.log('🎭 CharCreator:');
    const template = charResult.output.narrativeTemplate as string | undefined;
    const form = charResult.output.form as Record<string, unknown> | undefined;
    if (template) console.log(`  Template: ${template.substring(0, 200)}...`);
    if (form) {
      const fields = (form.fields as Array<Record<string, unknown>>) ?? [];
      console.log(`  Form: ${form.title} (${fields.length} fields)`);
      for (const f of fields) {
        console.log(`    - [${f.type}] ${f.name}: ${f.label}${f.options ? ` (${(f.options as string[]).join('/')})` : ''}`);
      }
      console.log(`  Submit: ${form.submitLabel}`);
    }
  }

  // Check pendingInputs
  if (turn1.pendingInputs && turn1.pendingInputs.length > 0) {
    console.log(`\n⏳ Pending inputs: ${turn1.pendingInputs.length} form(s)`);
  }

  // ═══ Player submits character creation form ═══
  console.log('\n' + '─'.repeat(60));
  console.log('📝 Player submits character creation form');
  console.log('─'.repeat(60));

  const formId = (charResult?.output?.form as Record<string, unknown>)?.formId as string ?? 'char-creation';
  const playerValues = {
    characterName: '林清风',
    gender: '男',
    spiritRoot: '水灵根',
    appearance: '面容清秀，眉目间透着一股书卷气',
  };
  console.log(`  Name: ${playerValues.characterName}`);
  console.log(`  Gender: ${playerValues.gender}`);
  console.log(`  Spirit Root: ${playerValues.spiritRoot}`);

  const submitRes = await app.request(`/v2/session/${sessionId}/submit-inputs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      turnId: turn1.turnId,
      formId,
      values: playerValues,
    }),
  });
  const submitBody = await submitRes.json() as { filledNarrative: string; accepted: boolean };
  console.log(`\n✅ Accepted: ${submitBody.accepted}`);
  console.log(`📖 Filled narrative: ${submitBody.filledNarrative.substring(0, 200)}...`);

  // ═══ Turn 2: Narrator continues with character info ═══
  console.log('\n' + '═'.repeat(60));
  console.log('🎮 Turn 2: Narrator 基于角色信息续写');
  console.log('═'.repeat(60));

  const t2 = Date.now();
  const turn2Res = await app.request(`/v2/session/${sessionId}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '我环顾四周，试图回忆起更多信息' }),
  });
  const turn2 = await turn2Res.json() as typeof turn1;
  const narrator2 = turn2.runtimeResults.find(r => r.pluginId === 'core-narrator');
  console.log(`\n📖 (${Date.now() - t2}ms):`);
  console.log(String(narrator2?.output?.narrativeOutput ?? '(no output)'));

  // ═══ Verify persistence ═══
  console.log('\n' + '═'.repeat(60));
  console.log('🔍 Persistence verification');
  console.log('═'.repeat(60));

  const allMessages = await store.listTurnMessages(sessionId);
  console.log(`  TurnMessages: ${allMessages.length} total`);
  for (const m of allMessages) {
    const tag = m.name ? `[${m.name}]` : `[${m.sourceType}]`;
    const hasPending = m.pendingInput ? ' 📋FORM' : '';
    console.log(`    ${m.turnId.substring(0,8)}.. ${tag} ${m.role}: ${m.content.substring(0, 60)}...${hasPending}`);
  }

  const playerInputs = await store.listPlayerInputs(sessionId);
  console.log(`  PlayerInputs: ${playerInputs.length}`);

  const turnResults = await store.listTurnResults(sessionId);
  console.log(`  TurnResults: ${turnResults.length}`);

  await store.close();
  console.log(`  📁 DB: ${(fs.statSync(DB_PATH).size / 1024).toFixed(1)} KB`);

  console.log('\n' + '═'.repeat(60));
  console.log('✅ CharCreator E2E complete!');
  console.log('═'.repeat(60));
}

main().catch((err) => {
  console.error('❌ Failed:', err);
  process.exit(1);
});
