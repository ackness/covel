# 插件开发指南 · 进阶（Agent + 本地 JS）

> 面向**进阶创作者**：已经会用 PLUGIN.md 写零代码插件，现在要加本地 JS 工具、声明玩家交互、跨插件注入数据、暴露 RPC action，并为插件写基本的集成测试。

> **前置要求**：先完成 [零代码指南](./plugin-authoring-zero-code.md)（frontmatter、触发类型、内置工具）。

> **读完你能做到**
>
> - 用 `tool({ parameters: z.object(...) })` 工厂函数写一个本地工具，在 `entry` 模块里 `covel.registerTool` 注册并用 `tools.plugin` 声明可见性
> - 用 `interaction` 返回字段让工具产出玩家交互块（form / choice / confirmation）
> - 用 `input.inject` 声明跨 runtime 的 prompt 注入依赖
> - 用 `covel.registerRpc` 暴露结构化 action 给前端 / 外部代理
> - 用 `@covel/plugin-test-utils` + `MockLLM` 写插件测试

---

## 0. 三种写法：agent / function / 两者组合（掷骰范例）

零代码插件只能用 **agent runtime**（纯 `PLUGIN.md` 提示词）。进了本层，你多了两种选择：

- **function runtime** —— 一段 JS handler，确定地算。要公平 / 精确 / 可复现 / 零成本的事用它，典型是掷骰的随机数、计数、伤害公式（交给 LLM 不靠谱）。声明 `runtimeType: function` + `handler`。
- **两者组合**（创作者常叫"混合模式"）—— 一个玩法里，确定的部分用 function，要叙述 / 判断的部分用 agent。Covel 没有 "hybrid" 这种东西，"组合"就是把现有积木拼起来。

**掷骰范例**：玩家掷骰，点数要公平（function 的活），结果要 DM 口吻叙述（agent 的活）。有两种拼法：

- **拼法 A · 一个 agent + 一个工具**（最简单）：写一个 agent runtime，提示词说"先调 `roll-dice` 工具拿点数，再按点数和当前剧情用 DM 口吻叙述这次掷骰"。`roll-dice` 是个本地工具（见 §1），内部用随机数——agent 通过**调用工具**稳定触发那段确定逻辑，而不是靠它"自己掷"。
- **拼法 B · 一个 function + 一个 agent**（掷骰逻辑复杂、想单独复用时）：function runtime 掷骰并把点数作为 output；agent runtime 用 `input.inject`（见 §3）拿到点数，负责叙述。`plugins/npc-graph`、`plugins/char-creator` 就是这种"function + agent 协作"的真实例子。

怎么选：能容忍 LLM 偶尔换花样 / 判错 → agent；要确定 → function；两者都要 → 组合，确定的交 function / 工具、叙述的交 agent。

> 这里说的"写法 / 模式"是**执行方式**；和 frontmatter 的 `trigger`（[Trigger mode](../glossary.md)：runtime 何时运行）不是一回事。背后的设计理念见 [architecture/design-principles.md](../architecture/design-principles.md)。

---

## 1. 创建本地工具

当内置工具不够用时，可以用 JS/TS 编写自定义工具。一个工具就是一个文件，使用 `tool()` 包装函数：

```
plugins/my-codex/
├── PLUGIN.md
├── package.json
├── server/
│   └── index.js           # 统一服务端入口（frontmatter entry 指向）
└── tools/
    └── unlock-codex-entries.js
```

**tools/unlock-codex-entries.js：**

插件本地工具使用**工厂函数**模式 — entry 模块调用工厂时传入 `covel.toolkit`，即 `{ tool, z, shortId, shortIdBatch, withPendingProposals, store }` 注入包：

```javascript
// 工厂函数接收框架注入
export default function ({ tool, z, shortIdBatch }) {
  const codexEntrySchema = z.object({
    category: z
      .enum(["monster", "item", "location", "lore", "character", "skill"])
      .describe("知识类别"),
    title: z.string().min(1).describe("条目标题"),
    content: z.string().min(10).describe("2-3 句话的描述"),
    tags: z.array(z.string()).min(1).max(5).describe("标签列表"),
    rarity: z
      .enum(["common", "uncommon", "rare", "legendary"])
      .default("common")
      .describe("稀有度，影响 UI 展示样式"),
    imageHint: z.string().optional().describe("可选的视觉描述提示"),
  });

  return tool({
    name: "unlock-codex-entries",
    description:
      '批量解锁新的图鉴条目。每个条目会生成一张"知识发现"卡片展示给玩家。',
    parameters: z.object({
      entries: z
        .array(codexEntrySchema)
        .min(1)
        .describe("要解锁的图鉴条目列表"),
    }),
    execute: async (params, context) => {
      // 使用 shortIdBatch 生成 LLM 友好的短 ID（如 'codex-fire-magic'）
      const ids = shortIdBatch(
        "codex",
        params.entries.map((e) => e.title),
        context.sessionId,
      );

      const results = params.entries.map((entry, i) => ({
        entryId: ids[i],
        ...entry,
        unlockedAt: new Date().toISOString(),
      }));

      return {
        unlocked: results.length,
        entries: results,
        // 框架对 `block.type === 'ui-spec'` 做统一解包：直接拿到
        // `data.spec` 传给 json-render。插件可以用目录里注册的任意组件
        // （如 EntryCard、Stack、Alert），无需框架 side 注册新的 block type。
        ui: results.map((entry) => ({
          type: "ui-spec",
          entryId: entry.entryId,
          spec: {
            type: "EntryCard",
            props: {
              title: entry.title,
              category: entry.category,
              rarity: entry.rarity,
              isNew: true,
            },
          },
        })),
      };
    },
  });
}
```

**关键点：**

1. **工厂函数** — `export default function ({ tool, z, shortId, shortIdBatch, withPendingProposals, store })` 接收 `covel.toolkit` 注入，通常无需 import
2. **Zod 定义参数** — 框架自动从 Zod schema 生成 JSON Schema 注入 LLM 上下文，LLM 才知道如何调用
3. **`.describe()` 很重要** — 每个参数的 describe 会作为参数说明发给 LLM
4. **`execute(params, context)`** — params 是经过 Zod 验证的输入，context 包含会话信息
5. **短 ID** — 使用 `shortId()` / `shortIdBatch()` 代替 UUID，让 LLM 能精确引用实体
6. **持久化写入** — 需要写 plugin-data 时优先返回 `withPendingProposals(...)`，让 commit chain 统一落盘、trace 和触发 SSE
7. **返回值** — 任意 JSON，会作为 tool result 返回给 LLM

**server/index.js** — 在统一服务端入口里注册工具（`PluginAPI` facade，约定参数名 `covel`）：

```javascript
import makeUnlockCodexEntries from "../tools/unlock-codex-entries.js";

/** @param {import('@covel/runtime').PluginAPI} covel */
export default function (covel) {
  covel.registerTool(makeUnlockCodexEntries(covel.toolkit));
}
```

在 PLUGIN.md frontmatter 中声明 entry，并用 `tools.plugin`（工具**名字**列表）声明该 runtime 的 LLM 可见哪些 entry 注册的工具：

```yaml
entry: ./server/index.js
tools:
  plugin:
    - unlock-codex-entries
  builtin:
    - create-notification
```

> 旧的 `tools.local`（路径列表）frontmatter 写法已移除（声明即加载失败），迁移对照见 [高级指南的迁移附录](./plugin-authoring-advanced.md#附录旧注册字段迁移)。

**package.json** — 工厂注入让工具在运行时无需 import 任何框架包；`@covel/runtime` 只是 JSDoc 类型引用（devDependency）：

```json
{
  "name": "@covel/plugin-my-codex",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@covel/plugin-test-utils": "workspace:*",
    "@covel/runtime": "workspace:*",
    "vitest": "^4.1.2"
  }
}
```

## 2. 交互协议（interaction）

工具可以通过返回值中的 `interaction` 字段声明"需要玩家交互"。框架自动处理渲染、等待、和结果注入。

**三种交互类型：**

### form — 表单填写

```javascript
execute: async (params) => ({
  created: true,
  interaction: {
    type: "form",
    interactionId: params.formId,
    title: params.title,
    fields: params.fields,
    submitLabel: params.submitLabel,
    narrativeTemplate:
      "你的名字叫 {{characterName}}，拥有 {{spiritRoot}} 灵根。",
  },
});
```

### choice — 选项选择

```javascript
execute: async (params) => ({
  created: true,
  interaction: {
    type: "choice",
    interactionId: params.choiceId,
    prompt: params.prompt,
    choices: params.choices,
    narrativeTemplate: "你思考片刻后决定：{{selectedLabel}}。",
  },
});
```

### confirmation — 确认/取消

```javascript
execute: async (params) => ({
  created: true,
  interaction: {
    type: "confirmation",
    interactionId: "confirm-1",
    narrativeTemplate: "你{{confirmed}}了这个请求。", // "确认" 或 "取消"
  },
});
```

**协议流程：**

```
工具返回 interaction
  → 框架扫描所有 tool result 的 interaction（通用，无硬编码）
  → 聚合存入 TurnMessage.pendingInput
  → 前端渲染交互 UI
  → 玩家提交
  → 框架用 narrativeTemplate 替换占位符，生成自然语言
  → 追加到消息历史（LLM 看到的和普通消息一样）
```

**`narrativeTemplate` 由插件作者编写**，决定了交互结果如何翻译为 LLM 可理解的叙事文本。

## 3. 注入其他插件的输出

通过 `input.inject` 声明依赖其他插件的输出。

以 `char-creator` 为例——它需要读取 `narrator` 的开场叙事：

```yaml
trigger:
  type: scheduled
  interval: 1
  maxTriggerCount: 1
input:
  inject:
    - kind: runtime
      from: narrator # 来源插件 ID
      field: narrativeOutput # 要提取的输出字段
      as: "<narrator-opening>" # 包裹的 XML 标签名
```

在提示词中通过模板变量访问注入的数据：

```markdown
## 主叙事开场

<narrator-opening>{{ inputs.narrator.narrator.narrativeOutput }}</narrator-opening>
```

**注意：**

- `from` 指定来源插件的 ID
- `field` 指定要提取的字段名
- `as` 指定包裹的 XML 标签名，帮助 LLM 区分不同数据来源
- 如果来源插件尚未执行（优先级更低），注入会为空

## 4. 暴露 RPC action

如果你的插件想被前端或外部代理通过结构化指令调用(而不是触发 turn pipeline),在 `entry` 模块里用 `covel.registerRpc` 注册 action:

```js
// server/index.js（PLUGIN.md: entry: ./server/index.js）
import regenerate from "../rpc/regenerate.js";
import cancel from "../rpc/cancel.js";

/** @param {import('@covel/runtime').PluginAPI} covel */
export default function (covel) {
  covel.registerRpc("regenerate", regenerate, {
    description: "重新生成上一次的 narrator 输出",
  });
  // trustLevel 只能收紧、不能提升插件来源信任,慎用
  covel.registerRpc("cancel", cancel, { trustLevel: "builtin" });
}
```

handler 是一个函数(可以内联,也可以放独立模块):

```js
// plugins/my-plugin/rpc/regenerate.js

/**
 * @param {unknown} payload  调用方传入的载荷
 * @param {{ sessionId: string, pluginId: string, action: string, store: any }} ctx
 * @returns {Promise<unknown>}
 */
export default async function regenerate(payload, ctx) {
  // 直接读 store / 触发 RPC / 写 plugin_data
  const messages = await ctx.store.listTurnMessages();
  // ...
  return { ok: true, regeneratedAt: new Date().toISOString() };
}
```

> 旧的 frontmatter `rpc:` 声明式写法（`handler` 路径 + lazy import）已弃用（保留一个发布周期），迁移对照见 [高级指南的迁移附录](./plugin-authoring-advanced.md#附录旧注册字段迁移)。

调用方:

```bash
curl -X POST http://localhost:3001/api/sessions/$SESSION_ID/plugin-rpc \
  -H 'Content-Type: application/json' \
  -d '{"pluginId": "my-plugin", "action": "regenerate", "payload": {}}'
```

**约束:**

- action 名必须是 kebab-case
- 不能以 `framework-` 开头(保留命名空间)
- builtin/official 插件的 entry 在启动时执行,action 立即可用;community 插件延迟到审批通过 / 首次激活时执行 entry。handler 抛错由框架捕获并返回 500
- payload 可以是任意 JSON,推荐在 handler 内自己用 zod 校验
- handler 的 `store` 是 raw `DataStore`,可以读写,但**不要绕过 commit 链做大型状态变更**——那是 turn pipeline 的职责。RPC 适合小范围读 / 通知 / 重新触发的场景

**框架默认 action(无需声明,所有插件可直接调):**

| Action        | 说明                                |
| ------------- | ----------------------------------- |
| `submit-form` | 持久化玩家输入并填充 narrative 模板 |

详细 API 见 [docs/reference/api.md `POST /api/sessions/:id/plugin-rpc`](../reference/api.md#post-apisessionsidplugin-rpc)。

## 5. 测试你的插件

使用 `@covel/plugin-test-utils` 做单元测试，用 runtime cases（`pnpm test:runtime`）做端到端验证。

推荐最少覆盖四类行为：

1. manifest / runtime 发现与加载（`pnpm test:runtime` 天然覆盖）
2. local tool 参数与返回结构
3. handler / agent runtime 的核心输出
4. `plugin_data` 与 `ui.message / ui.right` 的契约

**安装依赖：**

```json
{
  "devDependencies": {
    "@covel/plugin-test-utils": "workspace:*",
    "vitest": "^4.1.2"
  }
}
```

**local tool 单元测试（tests/my-plugin.test.js）** —— 直接 import 工具工厂，注入 toolkit 与 mock store 后调用 `execute`（完整真实范例：[`plugins/codex/tests/codex.test.js`](../../plugins/codex/tests/codex.test.js)）：

```js
import { describe, it, expect } from "vitest";
import { tool, z, shortIdBatch, getPendingProposals } from "@covel/tools";
import createUnlockCodexEntries from "../tools/unlock-codex-entries.js";

describe("unlock-codex-entries", () => {
  it("unlocks a location entry", async () => {
    const unlockTool = createUnlockCodexEntries({
      tool,
      z,
      shortIdBatch,
      store: mockPluginDataStore, // in-memory stub，见 codex.test.js
    });

    const result = await unlockTool.execute(
      { entries: [{ category: "location", title: "青萍山", content: "…" }] },
      { sessionId: "sess-1", turnId: "turn-1", pluginId: "my-codex" },
    );

    // 写入以 proposal 形式挂在返回值上，由框架 commit
    expect(getPendingProposals(result).length).toBeGreaterThan(0);
  });
});
```

function runtime handler 用 `makeManualFunctionContext` 直接调用（真实范例：[`plugins/character-presence/tests/handler.test.js`](../../plugins/character-presence/tests/handler.test.js)）。需要跑完整 turn（tool loop / event 链 / proposal commit）时，参考 [plugin-testing.md](./plugin-testing.md) 的手搓 turn-executor 模式。

**测试数据工厂：**

```typescript
import {
  makeTurnInput,
  makeTriggerContext,
  makeRuntimeResult,
} from "@covel/plugin-test-utils";

// 创建带默认值的测试数据，可覆盖任意字段
const input = makeTurnInput({ playerMessage: "我要去云梦泽" });
const ctx = makeTriggerContext({ turnNumber: 5, triggerCount: 2 });
const result = makeRuntimeResult({ status: "success" });
```

运行测试：

```bash
pnpm --filter @covel/plugin-my-codex test
```

更详细的测试模式（runtime cases、HTTP E2E、真实 LLM 验证）见 [插件测试指南](./plugin-testing.md)。

---

## 下一步

- 想用完整 TypeScript 类型、拆多 runtime、自定义审批、发布到社区？ → [高级指南（TypeScript + 审批 + 发布）](./plugin-authoring-advanced.md)
- 想写交互 UI 面板的 json-render spec？ → [插件 UI 与 runtime 指南](./plugin-ui-runtime-guidelines.md)
- 想看所有插件的 frontmatter 速查与调度层级？ → [插件注册表 `docs/reference/plugins.md`](../reference/plugins.md)
