/**
 * core-npc-graph end-to-end integration test (no real LLM).
 *
 * Verifies the full Phase 2 + Phase 3 loop:
 *
 *   1. Simulate the LLM-driven extractor by calling upsert-npc-graph
 *      directly with the kind of payload the agent runtime would
 *      produce after reading a narrator turn.
 *   2. Run the rag-retriever handler against the same store with a
 *      player message that mentions one of the seeded NPCs.
 *   3. Assert the retrieved npcContext contains the expected facts and
 *      that 2-hop expansion surfaces the wider relationship cluster.
 *
 * No network calls, no LLM. Uses the same in-memory mock store as the
 * other plugin tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { tool, z, shortIdBatch } from '@covel/tools';
import createUpsertNpcGraph from '../tools/upsert-npc-graph.js';
import retrieverHandler from '../runtimes/rag-retriever/handler.js';

function createMockStore() {
  /** @type {Map<string, any>} */
  const data = new Map();
  const makeKey = (sid, pid, ns, k) => `${sid}:${pid}:${ns}:${k}`;
  return {
    data,
    async setPluginData(record) {
      data.set(makeKey(record.sessionId, record.pluginId, record.namespace, record.key), {
        namespace: record.namespace,
        key: record.key,
        value: record.value,
      });
    },
    async setPluginDataBatch(records) {
      for (const r of records) await this.setPluginData(r);
    },
    async getPluginData(sessionId, pluginId, namespace, key) {
      return data.get(makeKey(sessionId, pluginId, namespace, key)) ?? null;
    },
    async listPluginData(sessionId, pluginId, namespace) {
      const prefix = namespace
        ? `${sessionId}:${pluginId}:${namespace}:`
        : `${sessionId}:${pluginId}:`;
      const out = [];
      for (const [k, v] of data) {
        if (k.startsWith(prefix)) out.push(v);
      }
      return out;
    },
  };
}

const SESSION = 'sess-integration';
const PLUGIN = 'core-npc-graph';

describe('core-npc-graph end-to-end (extractor → retriever)', () => {
  let store;
  let upsertTool;

  beforeEach(() => {
    store = createMockStore();
    upsertTool = createUpsertNpcGraph({ tool, z, shortIdBatch, store });
  });

  it('extracts a small cast on turn 3, then retrieves them on turn 4', async () => {
    // ── Simulate Phase 2: extractor agent ran on turn 3 ─────────
    // The LLM, after reading narrator output, calls upsert-npc-graph
    // with a coherent batch of nodes and edges. We replay that call.
    const extractorCtx = {
      sessionId: SESSION,
      turnId: 'turn-3',
      pluginId: PLUGIN,
      runtimeId: `${PLUGIN}/extractor`,
    };
    const extractResult = await upsertTool.execute(
      {
        nodes: [
          {
            name: '萧衍笙',
            type: 'individual',
            labels: ['sect-leader'],
            summary: '碧波宗宗主，云梦泽修为最高者，金丹九层。傲慢但强大。',
          },
          {
            name: '碧波宗',
            type: 'faction',
            labels: ['sect'],
            summary: '云梦泽最大的宗门，占据一等灵脉碧波灵渊。',
          },
          {
            name: '陆沉渊',
            type: 'individual',
            labels: ['sect-leader', 'researcher'],
            summary: '青萍宗宗主，据说在闭关冲击元婴，实际在研究古老阵法。',
          },
        ],
        edges: [
          {
            sourceName: '萧衍笙',
            targetName: '碧波宗',
            relation: 'WORKS_FOR',
            strength: 0.9,
            fact: '萧衍笙是碧波宗的现任宗主，掌握全宗一应事务。',
          },
          {
            sourceName: '萧衍笙',
            targetName: '陆沉渊',
            relation: 'COMPETES_WITH',
            strength: -0.4,
            fact: '萧衍笙长期视陆沉渊为潜在竞争者，灵脉盟约的真正目的是冻结现状以维持碧波宗优势。',
          },
        ],
      },
      extractorCtx,
    );

    expect(extractResult.nodes.created).toBe(3);
    expect(extractResult.edges.created).toBe(2);

    // ── Simulate Phase 3: retriever runs at the start of turn 4 ─
    // The player mentions Xiao Yansheng — retriever should surface
    // the WORKS_FOR edge (1-hop) and the COMPETES_WITH edge (also
    // 1-hop, going outbound to 陆沉渊).
    const retrieverCtx = {
      sessionId: SESSION,
      turnId: 'turn-4',
      pluginId: PLUGIN,
      playerMessage: '你试着私下打听萧衍笙在灵脉盟约里的真实意图。',
      locale: 'zh-CN',
      store,
      completedResults: new Map(),
      config: {},
    };
    const retrieved = await retrieverHandler(retrieverCtx);

    expect(retrieved.npcContext).toBeTruthy();
    expect(retrieved.npcContext).toContain('萧衍笙');
    expect(retrieved.npcContext).toContain('碧波宗');
    expect(retrieved.npcContext).toContain('WORKS_FOR');
    expect(retrieved.npcContext).toContain('COMPETES_WITH');
    expect(retrieved.npcContext).toContain('灵脉盟约');

    // 1-hop neighbours of 萧衍笙
    expect(retrieved.matchedNodes).toHaveLength(3); // seed + 碧波宗 + 陆沉渊
    expect(retrieved.edgeCount).toBe(2);
  });

  it('retriever returns empty when player mentions no known NPC', async () => {
    // Seed something
    await upsertTool.execute(
      {
        nodes: [
          { name: 'Solo', type: 'individual', summary: 'A lone wanderer.' },
        ],
      },
      {
        sessionId: SESSION,
        turnId: 'turn-1',
        pluginId: PLUGIN,
        runtimeId: `${PLUGIN}/extractor`,
      },
    );

    const retrieved = await retrieverHandler({
      sessionId: SESSION,
      turnId: 'turn-2',
      pluginId: PLUGIN,
      playerMessage: 'You walk through an empty courtyard at dusk.',
      locale: 'en-US',
      store,
      completedResults: new Map(),
      config: {},
    });

    expect(retrieved.npcContext).toBe('');
    expect(retrieved.matchedNodes).toEqual([]);
  });

  it('preserves prior turn state across two extractor calls', async () => {
    const ctx1 = {
      sessionId: SESSION,
      turnId: 'turn-1',
      pluginId: PLUGIN,
      runtimeId: `${PLUGIN}/extractor`,
    };
    const ctx2 = { ...ctx1, turnId: 'turn-3' };

    // Turn 1: introduce Alice and Bob with a TRUSTS edge
    await upsertTool.execute(
      {
        nodes: [
          { name: 'Alice', type: 'individual', summary: 'Merchant from the eastern quarter.' },
          { name: 'Bob', type: 'individual', summary: "Alice's longtime business partner." },
        ],
        edges: [
          {
            sourceName: 'Alice',
            targetName: 'Bob',
            relation: 'TRUSTS',
            strength: 0.7,
            fact: 'Alice has trusted Bob for many years through hard times.',
          },
        ],
      },
      ctx1,
    );

    // Turn 3: Alice now also FEARS a new character Charlie
    await upsertTool.execute(
      {
        nodes: [
          { name: 'Charlie', type: 'individual', summary: 'A guard captain who threatened Alice.' },
        ],
        edges: [
          {
            sourceName: 'Alice',
            targetName: 'Charlie',
            relation: 'FEARS',
            strength: -0.6,
            fact: 'Alice fears Charlie after he threatened her cart at the market.',
          },
        ],
      },
      ctx2,
    );

    // Retriever sees the full graph
    const retrieved = await retrieverHandler({
      sessionId: SESSION,
      turnId: 'turn-4',
      pluginId: PLUGIN,
      playerMessage: 'You greet Alice as she packs her cart.',
      locale: 'en-US',
      store,
      completedResults: new Map(),
      config: {},
    });

    expect(retrieved.npcContext).toContain('Alice');
    expect(retrieved.npcContext).toContain('Bob');
    expect(retrieved.npcContext).toContain('Charlie');
    expect(retrieved.npcContext).toContain('TRUSTS');
    expect(retrieved.npcContext).toContain('FEARS');
    expect(retrieved.edgeCount).toBe(2);
  });
});
