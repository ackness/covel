/**
 * Test model override via API.
 *
 * Turn 1: default model (ds/DeepSeek from PLUGIN.md)
 * Turn 2: API override to qwen (Qwen/DashScope)
 *
 * Usage:
 *   npx tsx --env-file=.env --env-file=.env.llm scripts/test-model-override.ts
 */

import path from 'node:path';
import fs from 'node:fs';
import { bootstrapV2 } from '../apps/server/src/routes/v2/bootstrap.js';
import { createAiStack } from '../apps/server/src/ai-setup.js';
import { createGatewayAdapter } from '../packages/runtime/src/gateway-llm-adapter.js';
import { createMemoryStore } from '../packages/store/src/memory/memory-store.js';

const PLUGINS_DIR = path.resolve(import.meta.dirname, '../plugins');

async function main() {
  console.log('🔄 Model Override Test\n');

  const aiStack = createAiStack();
  const apiKeys: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.endsWith('_API_KEY') && value) {
      apiKeys[key.replace(/_API_KEY$/, '').toLowerCase()] = value;
    }
  }
  const llm = createGatewayAdapter(aiStack.gateway, { apiKeys });
  const store = createMemoryStore();

  const { app } = await bootstrapV2({
    pluginsDir: PLUGINS_DIR,
    llmAdapter: llm,
    store,
  });

  // Start session
  const startRes = await app.request('/v2/session/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plugins: ['core-narrator'] }),
  });
  const { sessionId } = await startRes.json() as { sessionId: string };
  console.log(`📋 Session: ${sessionId}\n`);

  // Turn 1: Default model (ds from PLUGIN.md)
  console.log('─'.repeat(60));
  console.log('🎮 Turn 1: Using default model (PLUGIN.md: ds → DeepSeek)');
  console.log('─'.repeat(60));

  const t1 = Date.now();
  const turn1Res = await app.request(`/v2/session/${sessionId}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '你好，请用一句话介绍你自己' }),
  });
  const turn1 = await turn1Res.json() as {
    runtimeResults: Array<{ status: string; output: { narrativeOutput?: string } | null }>;
  };
  const out1 = turn1.runtimeResults[0]?.output?.narrativeOutput ?? '(no output)';
  console.log(`📖 (${Date.now() - t1}ms): ${out1.substring(0, 150)}...\n`);

  // Turn 2: API override → qwen
  console.log('─'.repeat(60));
  console.log('🎮 Turn 2: API override model=qwen → Qwen/DashScope');
  console.log('─'.repeat(60));

  const t2 = Date.now();
  const turn2Res = await app.request(`/v2/session/${sessionId}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '你好，请用一句话介绍你自己', model: 'qwen' }),
  });
  const turn2 = await turn2Res.json() as typeof turn1;
  const out2 = turn2.runtimeResults[0]?.output?.narrativeOutput ?? '(no output)';
  console.log(`📖 (${Date.now() - t2}ms): ${out2.substring(0, 150)}...\n`);

  // Turn 3: API override → fast (Qwen flash)
  console.log('─'.repeat(60));
  console.log('🎮 Turn 3: API override model=fast → Qwen Flash');
  console.log('─'.repeat(60));

  const t3 = Date.now();
  const turn3Res = await app.request(`/v2/session/${sessionId}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '你好，请用一句话介绍你自己', model: 'fast' }),
  });
  const turn3 = await turn3Res.json() as typeof turn1;
  const out3 = turn3.runtimeResults[0]?.output?.narrativeOutput ?? '(no output)';
  console.log(`📖 (${Date.now() - t3}ms): ${out3.substring(0, 150)}...\n`);

  console.log('═'.repeat(60));
  console.log('✅ Model override test complete!');
  console.log('  Turn 1: ds (DeepSeek) — default from PLUGIN.md');
  console.log('  Turn 2: qwen (Qwen) — API override');
  console.log('  Turn 3: fast (Qwen Flash) — API override');
  console.log('═'.repeat(60));
}

main().catch((err) => {
  console.error('❌ Failed:', err);
  process.exit(1);
});
