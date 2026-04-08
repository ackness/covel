/**
 * Real LLM integration test script.
 *
 * Uses the existing @covel/ai-provider gateway (supports all configured
 * providers: DeepSeek, Qwen/DashScope, OpenRouter, Anthropic, OpenAI, etc.)
 *
 * Usage:
 *   npx tsx --env-file=.env --env-file=.env.llm scripts/test-real-llm.ts
 *   npx tsx --env-file=.env --env-file=.env.llm scripts/test-real-llm.ts --slot=qwen
 */

import path from 'node:path';
import { bootstrapV2 } from '../apps/server/src/routes/v2/bootstrap.js';
import { createAiStack } from '../apps/server/src/ai-setup.js';
import { createGatewayAdapter } from '../packages/runtime/src/gateway-llm-adapter.js';

// Parse --slot=xxx from CLI args
const slotArg = process.argv.find((a) => a.startsWith('--slot='));
const slotOverride = slotArg?.split('=')[1];

const PLUGINS_DIR = path.resolve(import.meta.dirname, '../plugins-v2');

async function main() {
  console.log('🚀 Starting real LLM integration test...\n');

  // 1. Initialize the full ai-provider stack (reads llm.toml + .env.llm)
  const aiStack = createAiStack();

  // Show available slots
  const slotNames = aiStack.llmConfig
    ? Object.keys(aiStack.llmConfig.covel)
    : ['(legacy presets)'];
  console.log(`📡 Available slots: ${slotNames.join(', ')}`);

  // 2. Create LLM adapter bridging to the gateway
  // Gateway expects apiKeys keyed by provider name (e.g., "deepseek", "dashscope")
  // Env vars are like DEEPSEEK_API_KEY → provider name "deepseek"
  const apiKeys: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.endsWith('_API_KEY') && value) {
      const providerName = key.replace(/_API_KEY$/, '').toLowerCase();
      apiKeys[providerName] = value;
    }
  }

  const llm = createGatewayAdapter(aiStack.gateway, { apiKeys });

  // 3. Bootstrap V2 app
  const { app, registry } = await bootstrapV2({
    pluginsDir: PLUGINS_DIR,
    llmAdapter: llm,
  });

  console.log('✅ App bootstrapped. Plugins:', [...registry.getAll().keys()].join(', '));

  // Determine which slot the narrator will use
  const narratorSlot = slotOverride ?? 'ds';
  console.log(`🤖 Using slot: ${narratorSlot}\n`);

  // 4. Start session
  const startRes = await app.request('/v2/session/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locale: 'zh-CN', plugins: ['core-narrator'] }),
  });
  const startBody = await startRes.json() as { sessionId: string };
  console.log(`📋 Session started: ${startBody.sessionId}\n`);

  // 5. Turn 1
  console.log('─'.repeat(60));
  console.log('🎮 Turn 1: "我醒来发现自己在一个陌生的山洞里"');
  console.log('─'.repeat(60));

  const turn1Start = Date.now();
  const turn1Res = await app.request(`/v2/session/${startBody.sessionId}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '我醒来发现自己在一个陌生的山洞里' }),
  });

  if (!turn1Res.ok) {
    const err = await turn1Res.text();
    console.error(`❌ Turn failed (${turn1Res.status}):`, err);
    process.exit(1);
  }

  const turn1Body = await turn1Res.json() as {
    turnId: string;
    runtimeResults: Array<{
      pluginId: string;
      status: string;
      output: { narrativeOutput?: string } | null;
      error?: string;
      durationMs: number;
    }>;
    durationMs: number;
  };

  const narrator1 = turn1Body.runtimeResults[0];
  console.log(`\n📖 Narrator (${narrator1.status}, ${Date.now() - turn1Start}ms):`);
  if (narrator1.status === 'success') {
    console.log(narrator1.output?.narrativeOutput ?? '(no narrative output field)');
  } else {
    console.error('❌ Error:', narrator1.error);
  }

  // 6. Turn 2
  console.log('\n' + '─'.repeat(60));
  console.log('🎮 Turn 2: "我站起来查看洞穴四周，寻找出口"');
  console.log('─'.repeat(60));

  const turn2Start = Date.now();
  const turn2Res = await app.request(`/v2/session/${startBody.sessionId}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '我站起来查看洞穴四周，寻找出口' }),
  });

  const turn2Body = await turn2Res.json() as typeof turn1Body;
  const narrator2 = turn2Body.runtimeResults[0];
  console.log(`\n📖 Narrator (${narrator2.status}, ${Date.now() - turn2Start}ms):`);
  if (narrator2.status === 'success') {
    console.log(narrator2.output?.narrativeOutput ?? '(no narrative output field)');
  } else {
    console.error('❌ Error:', narrator2.error);
  }

  // 7. Summary
  const historyRes = await app.request(`/v2/session/${startBody.sessionId}/turns`);
  const historyBody = await historyRes.json() as { turns: Array<{ turnId: string }> };

  console.log('\n' + '═'.repeat(60));
  console.log('✅ Real LLM integration test complete!');
  console.log(`   Session: ${startBody.sessionId}`);
  console.log(`   Turns: ${historyBody.turns.length}`);
  console.log(`   Provider: ${narratorSlot} (via @covel/ai-provider gateway)`);
  console.log(`   Slots: ${slotNames.join(', ')}`);
  console.log('═'.repeat(60));
}

main().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
