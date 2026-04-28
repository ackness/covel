# 插件测试指引

给生成插件后的 agent 用。三层测试,按需选择,不一定全做。

| 层 | 跑什么 | 速度 | 何时必须 |
|---|---|---|---|
| **L1 Schema** | `validatePluginManifest` | 即时 | **每个 PLUGIN.md 都必须** |
| **L2 单元** | vitest 测纯逻辑 (tools / hooks / handlers) | <1s | 写了 `tools/*.js`、`handler.js`、`hooks/*.js` 就要写 |
| **L3 集成** | `createTestHarness` + `MockLLM` 跑一整个 turn | 1-3s | agent runtime + 注入/工具链涉及多 runtime 协作 |
| **L4 E2E** | `scripts/e2e-plugin-verify.ts` 真实 LLM | 30s+ | 只在最终验证阶段跑,可选 |

> 真实 LLM 不要在 CI 跑。L1-L3 全部用 MockLLM。

---

## L1 — Schema 校验(必做)

已在 `SKILL.md` 步骤 4 中说明。每个 `PLUGIN.md`(根 + 所有 `runtimes/*/PLUGIN.md`)都要单独跑。

---

## L2 — 单元测试

### 在哪写

`plugins/<id>/tests/*.test.js`(JS) 或 `*.test.ts`(TS)。`vitest` 已是 workspace 依赖,不需要装。

### 用什么

- 纯函数(无 LLM、无 store):直接断言返回值
- 工具(用 `tool(...)` 包装):用 mock store 验证它产生的 proposals 或 plugin-data 写入

### 模板:测一个本地工具

```js
// plugins/my-plugin/tests/my-tool.test.js
import { describe, it, expect } from 'vitest';
import { getPendingProposals, tool, z } from '@covel/tools';
import createMyTool from '../tools/my-tool.js';

function createMockPluginDataStore() {
  /** @type {Map<string, unknown>} */
  const data = new Map();
  const k = (s, p, ns, key) => `${s}:${p}:${ns}:${key}`;
  return {
    data,
    async setPluginData(r) {
      data.set(k(r.sessionId, r.pluginId, r.namespace, r.key), r);
    },
    async getPluginData(s, p, ns, key) { return data.get(k(s, p, ns, key)) ?? null; },
    async listPluginData(s, p, ns) {
      return [...data.entries()]
        .filter(([key]) => key.startsWith(`${s}:${p}:${ns}:`))
        .map(([, v]) => v);
    },
  };
}

describe('my-tool', () => {
  it('writes plugin-data with the right key', async () => {
    const store = createMockPluginDataStore();
    const ctx = {
      sessionId: 'sess-1',
      pluginId: 'my-plugin',
      runtimeId: 'my-plugin',
      turnId: 'turn-1',
      store,
    };

    const myTool = createMyTool();
    await myTool.execute({ name: 'foo', value: 42 }, ctx);

    // 工具产生的 proposals 通过 getPendingProposals(ctx) 取
    const proposals = getPendingProposals(ctx);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].type).toBe('plugin.data');
  });
});
```

> 实战参考:`plugins/codex/tests/codex.test.js`、`plugins/npc-graph/tests/npc-graph.test.js`。

### 模板:测一个 function runtime handler

```js
// plugins/my-plugin/tests/handler.test.js
import { describe, it, expect, vi } from 'vitest';
import handler from '../runtimes/my-runtime/handler.js';

describe('my-runtime handler', () => {
  it('emits event when given a valid prompt', async () => {
    const ctx = {
      sessionId: 'sess-1',
      pluginId: 'my-plugin',
      runtimeId: 'my-plugin/my-runtime',
      turnId: 'turn-1',
      manualPayload: { prompt: 'a dragon' },
      gateway: {
        // mock 任何 ctx.gateway 调用
        generateImage: vi.fn().mockResolvedValue({
          images: [{ url: 'https://example.com/img.png' }],
        }),
      },
      userSettings: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    const result = await handler(ctx);

    expect(result.pluginData[0].namespace).toBe('images');
    expect(ctx.gateway.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ presetId: 'image' }),
    );
  });
});
```

### 模板:测 PLUGIN.md frontmatter 形状

```js
import { describe, it, expect } from 'vitest';
import { discoverPlugins, loadPluginManifest } from '@covel/plugin-loader';
import path from 'node:path';

const PLUGINS_DIR = path.resolve(import.meta.dirname, '../../');

describe('my-plugin manifest', () => {
  it('declares the right tools and capabilities', async () => {
    const plugins = await discoverPlugins(PLUGINS_DIR);
    const me = plugins.find((p) => p.id === 'my-plugin');
    expect(me).toBeDefined();

    const manifest = await loadPluginManifest(me.path);
    expect(manifest.runtimes[0].tools.builtin).toContain('plugin-data-set');
    expect(manifest.runtimes[0].capabilities).toContain('narrative');
  });
});
```

### 跑

```bash
pnpm --filter @covel/plugin-<id> test         # workspace 内插件
pnpm vitest run plugins/<id>/tests             # 也行,直接路径
```

---

## L3 — 集成测试(MockLLM + harness)

只在你需要验证 **多个 runtime 协作** / **prompt 注入是否到位** / **agent 工具链是否被正确触发** 时才写。

### 模板:跑一整个 turn

```ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  MockLLM,
  createTestHarness,
  makeTurnInput,
} from '@covel/plugin-test-utils';

const PLUGINS_DIR = path.resolve(import.meta.dirname, '../../../plugins');

describe('my-plugin integration', () => {
  it('produces narrative + writes plugin-data on a single turn', async () => {
    // 让 MockLLM 返回特定的工具调用,模拟 agent 决策
    const llm = new MockLLM({
      defaultResponse: {
        content: '',
        toolCalls: [{
          id: 'call-1',
          name: 'plugin-data-set',
          arguments: { namespace: 'entries', key: 'k1', value: { ok: true } },
        }],
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 20 },
      },
    });

    const harness = await createTestHarness({
      pluginsDir: PLUGINS_DIR,
      activePlugins: ['my-plugin'],
      llm,
    });

    const result = await harness.executeTurn('look around');

    expect(result.runtimeResults[0].status).toBe('success');
    expect(llm.calls).toHaveLength(1);

    // 直接查 in-memory store 验证写入
    const rows = await harness.store.listPluginData('sess-test', 'my-plugin', 'entries');
    expect(rows).toHaveLength(1);
  });
});
```

### MockLLM 控制返回

| 场景 | 怎么做 |
|------|------|
| 总是返回同一个响应 | `new MockLLM({ defaultResponse: {...} })` |
| 模拟工具调用 | `defaultResponse.toolCalls = [{ id, name, arguments }]` |
| 模拟流式失败 | `defaultResponse.finishReason: 'error'` + 自定义 `content` |
| 多轮顺序响应 | 自己继承 `MockLLM`,在 `generate()` 里按 `this.calls.length` 分支 |

### Factory 工具

- `makeTurnInput({ playerMessage, sessionId, ... })` — 造 `TurnInput`
- `makeTriggerContext({ turnNumber, isManualTrigger, ... })` — 造 trigger 上下文(单测 `guard` 用)
- `makeRuntimeResult({ status, output, ... })` — 造 RuntimeResult fixture

### 注意

- `createTestHarness` 用的是 `MemoryStore`,每个 test 之间互相隔离(各自调用各自创建)
- `executeTurn` 跑完整管线:trigger → context → runtime → tool loop → commit
- 想跑多轮:连续调 `harness.executeTurn(...)`;`turnId` 自动递增

---

## L4 — 真实 LLM E2E(可选)

只在准备发布时跑一次。**不要进 CI**(费钱、慢、不稳)。

```bash
# 需要 .env.llm 里的真实 provider key
npx tsx --env-file=.env --env-file=.env.llm scripts/e2e-plugin-verify.ts \
  --slot e2e_local --turns 3 --plugins my-plugin
```

artefact 落在 `debugs/e2e-logs/`,含每个 turn 的 prompt、LLM raw response、proposals、commit 结果。

E2E 详细用法见 [`docs/guide/e2e-plugin-verify.md`](../../../docs/guide/e2e-plugin-verify.md)。

---

## 决策树

```
是否包含 PLUGIN.md?
└─ 是 → L1 必做

是否含 tools/*.js / handler.js / hooks/*.js?
└─ 是 → L2 必做(每个文件至少一个 happy path 测试)

是否含 input.inject / 多 runtime / event 链?
└─ 是 → L3 写一个跑通整 turn 的测试

是否准备发布(对外宣称稳定)?
└─ 是 → L4 跑一次,人工看 trace
```

测试**不是**门禁,但 L1+L2 的失败说明插件有破坏性问题,**必须**修。L3 失败可能只是 MockLLM 配错了,先看是真 bug 还是 fixture bug。
