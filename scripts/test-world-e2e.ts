/**
 * Complete E2E test: Load Cloudmere world → Create session → Multi-turn narrative
 *
 * Tests the full pipeline with a real world document and real LLM.
 *
 * Usage:
 *   npx tsx --env-file=.env --env-file=.env.llm scripts/test-world-e2e.ts
 */

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parse: parseYaml } = require('yaml') as { parse: (s: string) => unknown };
import { createAiStack } from '../apps/server/src/ai-setup.js';
import { createGatewayAdapter } from '../packages/runtime/src/gateway-llm-adapter.js';
import { createSqliteStore } from '../packages/store/src/sqlite/sqlite-store.js';
import {
  discoverPlugins,
  loadPluginSummary,
  loadPluginManifest,
  createPluginRegistry,
  loadRuntime as loadRuntimeFromDisk,
} from '../packages/plugin-loader/src/index.js';
import { executeTurn } from '../packages/runtime/src/turn-executor.js';
import type { RuntimeManifest, TurnInput } from '../packages/shared/src/types/index.js';
import type { LoadedRuntime } from '../packages/plugin-loader/src/types.js';
import type { DataStore } from '../packages/store/src/types.js';

// ── Paths ────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins-v2');
const WORLDS_DIR = path.join(ROOT, 'worlds');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'world-e2e-test.db');

// ── Load world ──────────────────────────────────────────────────

function loadWorld(worldId: string) {
  const worldDir = path.join(WORLDS_DIR, worldId);
  const manifestPath = path.join(worldDir, 'world.yaml');
  const manifest = parseYaml(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;

  // Load lore
  let lore = '';
  const lorePaths = [
    path.join(worldDir, 'WORLD.zh.md'),
    path.join(worldDir, 'WORLD.zh-CN.md'),
    path.join(worldDir, 'WORLD.md'),
  ];
  for (const p of lorePaths) {
    if (fs.existsSync(p)) {
      lore = fs.readFileSync(p, 'utf-8');
      break;
    }
  }

  return { manifest, lore };
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log('🌍 Complete World E2E Test: 九州・云梦泽 (Cloudmere)\n');

  // 1. Load world
  const { manifest: worldManifest, lore } = loadWorld('cloudmere');
  console.log(`📜 World: ${worldManifest.name}`);
  console.log(`   Summary: ${worldManifest.summary}`);
  console.log(`   Tags: ${worldManifest.tags?.join(', ')}`);
  console.log(`   Opening: ${worldManifest.dimensions?.startingConditions?.openingScenario?.substring(0, 60)}...`);

  // 2. Init store
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const store = createSqliteStore(DB_PATH);

  // 3. Init LLM
  const aiStack = createAiStack();
  const apiKeys: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.endsWith('_API_KEY') && value) {
      apiKeys[key.replace(/_API_KEY$/, '').toLowerCase()] = value;
    }
  }
  const llm = createGatewayAdapter(aiStack.gateway, { apiKeys });

  // 4. Discover and register plugins
  const registry = createPluginRegistry();
  const discoveries = await discoverPlugins(PLUGINS_DIR);
  const discoveryMap = new Map<string, typeof discoveries[number]>();
  const manifestCache = new Map<string, Awaited<ReturnType<typeof loadPluginManifest>>>();

  for (const discovery of discoveries) {
    discoveryMap.set(discovery.id, discovery);
    const summary = await loadPluginSummary(discovery);
    const manifests = await loadPluginManifest(discovery);
    manifestCache.set(discovery.id, manifests);
    registry.register({
      id: discovery.id,
      summary,
      manifest: manifests[0],
      loadedRuntimes: new Map(),
      status: 'registered',
    });
  }

  console.log(`\n🔌 Plugins: ${[...registry.getAll().keys()].join(', ')}`);

  // 5. Create session
  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();
  await store.createSession({
    id: sessionId,
    worldId: 'cloudmere',
    phase: 'playing',
    turnCount: 0,
    locale: 'zh-CN',
    activePlugins: ['core-narrator'],
    createdAt: now,
    updatedAt: now,
  });

  // Save world to store
  await store.upsertWorld({
    id: 'cloudmere',
    name: worldManifest.name,
    description: worldManifest.summary,
    locale: 'zh-CN',
    createdAt: now,
  });

  // Activate narrator
  registry.activate('core-narrator', sessionId);

  console.log(`📋 Session: ${sessionId}`);
  console.log(`🤖 LLM: ${worldManifest.dimensions?.startingConditions ? 'ds (DeepSeek)' : 'unknown'}\n`);

  // 6. Build world context for narrator
  const dimensions = worldManifest.dimensions ?? {};
  const worldContext = {
    lore: lore || worldManifest.summary,
    dimensions: JSON.stringify(dimensions, null, 2).substring(0, 4000), // Truncate for token limit
    openingScenario: dimensions.startingConditions?.openingScenario ?? '',
    tone: dimensions.tone?.narrativeStyle ?? '',
  };

  // Runtime loader with world context injection
  const loadRuntimeFn = async (manifest: RuntimeManifest): Promise<LoadedRuntime | undefined> => {
    for (const [pluginId, discovery] of discoveryMap) {
      const manifests = manifestCache.get(pluginId);
      if (manifests?.some((m) => m.manifest.name === manifest.name)) {
        return loadRuntimeFromDisk(discovery, manifest.name);
      }
    }
    return undefined;
  };

  // Helper to execute a turn
  async function doTurn(turnNumber: number, message: string): Promise<string> {
    const turnId = crypto.randomUUID();
    console.log('─'.repeat(60));
    console.log(`🎮 Turn ${turnNumber}: "${message}"`);
    console.log('─'.repeat(60));

    const start = Date.now();
    const activeRuntimes = registry.getActiveRuntimes(sessionId);

    const result = await executeTurn(
      { sessionId, turnId, playerMessage: message },
      activeRuntimes,
      {
        loadRuntime: loadRuntimeFn,
        llm,
        getConfig: () => ({ world: worldContext }),
        store,
      },
    );

    const narrator = result.runtimeResults[0];
    const output = narrator?.output as Record<string, unknown> | null;
    const narrative = (output?.narrativeOutput as string) ?? '(no output)';

    console.log(`\n📖 (${narrator?.status}, ${Date.now() - start}ms):`);
    console.log(narrative);
    console.log('');

    // Update session turn count
    await store.updateSession(sessionId, { turnCount: turnNumber, updatedAt: new Date().toISOString() });

    return narrative;
  }

  // 7. Execute multiple turns following the world's opening scenario
  await doTurn(1, '我正在坊市闲逛，师姐苏婉匆匆赶来找我');

  await doTurn(2, '我问苏婉发现了什么，为什么这么着急');

  await doTurn(3, '我决定跟苏婉一起去云梦泽深处探查野生灵脉，先去准备一些物资');

  // 8. Verify persistence
  console.log('═'.repeat(60));
  console.log('🔍 Verifying SQLite persistence...');
  console.log('═'.repeat(60));

  const savedSession = await store.getSession(sessionId);
  console.log(`  Session: ${savedSession ? 'FOUND' : 'MISSING'} (turns: ${savedSession?.turnCount})`);

  const savedTurns = await store.listTurnResults(sessionId);
  console.log(`  Turn results: ${savedTurns.length} saved`);

  for (let i = 0; i < savedTurns.length; i++) {
    const turn = savedTurns[i];
    const runtimes = await store.listRuntimeResults(sessionId, turn.turnId);
    console.log(`  Turn ${i + 1}: ${runtimes.length} runtime result(s), status: ${runtimes.map(r => r.status).join(', ')}`);
  }

  const savedWorld = await store.getWorld('cloudmere');
  console.log(`  World: ${savedWorld ? savedWorld.name : 'MISSING'}`);

  const dbSize = fs.statSync(DB_PATH).size;
  console.log(`  📁 DB: ${(dbSize / 1024).toFixed(1)} KB`);

  await store.close();

  console.log('\n' + '═'.repeat(60));
  console.log('✅ 九州・云梦泽 E2E test complete!');
  console.log('═'.repeat(60));
}

main().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
