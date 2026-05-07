# Prompt 结构参考（V2 三段式）

> 适用于 Covel 的 V2 Prompt Assembler（`packages/context/src/prompt-assembler.ts`）。
> V1 路径仍然保留并走 `context-builder.ts` 的单块 systemPrompt，本文不覆盖 V1。

V2 结构由 `devs/docs/insights/covel-improvement-plan.md` §A2 定义，分成 10 段（segments），灵感来自 SillyTavern Prompt Manager 和 NovelAI 的 Reserved Tokens 分配策略。目标：**prompt cache 友好 + 可插入点清晰 + 插件声明式扩展**。

## 1. 启用条件

V2 路径需要 **两个** 开关同时满足：

| 开关                                  | 位置             | 说明                       |
| ------------------------------------- | ---------------- | -------------------------- |
| 环境变量 `COVEL_PROMPT_V2=1`          | 服务端           | 全局 kill switch，默认 off |
| Plugin frontmatter `promptVersion: 2` | 每个 `PLUGIN.md` | 逐插件 opt-in，默认 1      |

两者都未启用时，走 V1 路径，V2 模块完全不被调用。

> **§A8 渐进式迁移**：这个"双重 gate"是故意的，让核心插件可以逐个迁移到 V2 而不强制一次性切换，也允许在生产环境通过 env 统一灰度开关。

## 2. 段位图

```
┌──────────────────────── system 前缀（稳定，可缓存）────────────────────────┐
│ [1]  Framework Preamble           ← session 内稳定（世界标题、游戏规则、locale）│
│ [2]  Working Memory               ← session 内慢变（玩家偏好、长期标志位）     │
│ [3]  Plugin Instructions          ← per-plugin 稳定（PLUGIN.md 正文）         │
│ [4]  WorldInfo: before-plugin     ← 关键字触发 constant + selective           │
│ [5]  Injects from upstream        ← 本回合上游 runtime 的输出                │
│ [6]  WorldInfo: after-plugin      ← 关键字触发                              │
└─────────────────────────────────────────────────────────────────────────────┘
┌──────────────────────── messages 主体（动态）──────────────────────────────┐
│ [7]  history (after pruning)      ← 被 Compactor / Pruner 裁剪后的消息历史    │
│ [8]  WorldInfo: at-depth:N        ← 插在倒数第 N 条消息前的关键字触发条目      │
│ [9]  Author's Note                ← 倒数第 4 条消息前的导演指令              │
│ [10] Post-History Instructions    ← 最末端的高权重高优先级指令                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 每段的语义

| #   | 名称                      | 变化频率                        | 归属                      | 进入 prompt cache      |
| --- | ------------------------- | ------------------------------- | ------------------------- | ---------------------- |
| 1   | Framework Preamble        | session 内稳定                  | framework                 | ✅                     |
| 2   | Working Memory            | session 内慢变                  | framework (S3-T3)         | ❌（避免慢变击穿缓存） |
| 3   | Plugin Instructions       | per-plugin 稳定                 | plugin (`PLUGIN.md` 正文) | ✅                     |
| 4   | WorldInfo before-plugin   | 动态                            | lorebook                  | ❌                     |
| 5   | Upstream Injects          | 动态                            | runtime                   | ❌                     |
| 6   | WorldInfo after-plugin    | 动态                            | lorebook                  | ✅（末尾 breakpoint）  |
| 7   | Message history           | 动态                            | runtime                   | —                      |
| 8   | WorldInfo at-depth        | 动态                            | lorebook                  | —                      |
| 9   | Author's Note             | per-plugin 稳定 + interpolation | plugin                    | —                      |
| 10  | Post-History Instructions | per-plugin 稳定 + interpolation | plugin                    | —                      |

> 段 2 Working Memory 故意**不**打 cache breakpoint。WM 是"慢变"的（每几回合更新一次 player preference / story flag），如果进缓存会频繁击穿。放在段 1 之后让它能享受前缀稳定的一部分收益，但自身变化不会击穿前面的缓存块。

## 3. 插件扩展点

V2 下，插件可以通过 `PLUGIN.md` frontmatter 声明以下字段：

```yaml
---
name: narrator
promptVersion: 2

# Segment 9 — Author's Note
authorsNote:
  content: |
    请以第三人称叙述，但在关键转折时给出角色的内心独白。
    当前导演目标: {{ story.flags.currentGoal }}
  depth: 4 # 插入位置 = 倒数第 depth 条消息前（默认 4）
  role: system # 生成的消息 role（默认 system）

# Segment 10 — Post-History Instructions
postHistory:
  content: |
    输出必须包含 <narrative> 标签和 <choices> 标签。
  role: system # 默认 system

# Compactor 使用的摘要焦点（S2-T2）
summaryFocus:
  - "主角的情绪线"
  - "当前目标进度"
  - "关键 NPC 关系变化"
---
```

### 3.1 多插件合并规则

当多个插件都声明了 `authorsNote` / `postHistory`：

- 按 `RuntimeManifest.priority` **升序** 合并（priority 数字小 = 更早进入 prompt）
- 同一 `(role, depth)` 的 authorsNote 用 `\n\n` 分隔合并
- 不同 depth 的 authorsNote 各自独立插入对应位置
- postHistory 按 role 分组，同 role 合并成一条消息追加到末尾

### 3.2 Interpolation

`authorsNote.content` / `postHistory.content` 支持 `{{ variable }}` 模板变量，使用 `@covel/context` 的 `interpolateTemplate`。可用变量：

- `{{ player.lastFormValues }}` — 最近一次 player 表单提交（JSON 字符串）
- `{{ config.worldSchema }}` / `{{ config.worldEntries }}` / `{{ config.worldDimensions }}`
- `{{ story.* }}` / `{{ player.* }}` — Working Memory 字段（需 `COVEL_WORKING_MEMORY_V1=1`）
- `{{ turn.number }}` / `{{ session.status }}`

## 4. Prompt Cache 标记（S2-T3）

### 4.1 Provider 分支策略

`@covel/ai-provider` 的 `ProviderConfig.cacheStrategy` 字段（默认由 provider 协议自动推导）：

| strategy             | Provider                              | 机制                                                                                         |
| -------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `anthropic-explicit` | Anthropic `messages.v1`               | 在 `system` 字段数组末尾打 `cache_control: { type: 'ephemeral' }` 标记，最多 4 个 breakpoint |
| `auto-prefix`        | OpenAI chat/responses、DeepSeek、Qwen | 客户端零改动，provider 自动前缀匹配                                                          |
| `none`               | 未知 / 未支持                         | 不做任何处理                                                                                 |

启用条件：环境变量 `COVEL_PROMPT_CACHE_V1=1`（默认 off）。关闭时 `ProtocolEventType` 以外的所有路径字节等价于 pre-S2-T3。

### 4.2 Anthropic Breakpoint 位置

V2 Assembler 在组装时会在以下段的**末尾**插入 PUA sentinel (`\uE000`)，Anthropic adapter 读到 sentinel 后把 `system` 字段切成 `<text block>` 数组并打 `cache_control`：

1. 段 1 末（Framework Preamble 结束处）
2. 段 3 末（Plugin Instructions 结束处）
3. 段 6 末（WorldInfo after-plugin 结束处）

段 7（messages 中部）的第 4 个 breakpoint 暂未接入，tracked as FU-5 — 它需要 turn-executor 侧的改动，因为段 7 不在 `system` 字段里。

### 4.3 Sentinel 为什么嵌在字符串里

V2 对外暴露的 `AssembledContext.systemPrompt` 仍是 **一个 `string`**，运行时 (turn-executor) 不感知段结构。这是为了维持 V1 / V2 对 turn-executor 的接口一致性。

PUA sentinel (`\uE000`) 是 Unicode "私用区"字符，正常 prompt 内容绝不会出现，Anthropic adapter 用它把字符串切成段数组。OpenAI 系 adapter **不读 sentinel**，所以字符串对它们仍然是字节稳定的——自动前缀匹配照常工作。

## 5. 迁移 playbook

### 5.1 单个插件从 V1 迁移到 V2

1. **阅读插件 PLUGIN.md** 确认正文没有依赖 V1 特有的 prompt 格式（如硬编码"你将收到以下 sections:"这类）。通常 PLUGIN.md 正文直接作为段 3 原样填入，不需要改。
2. **加 frontmatter**：`promptVersion: 2`。
3. **补 parity test**：在 `plugins/<id>/tests/v1-v2-parity.test.ts` 里用 `MockLLM` + 固定 TurnInput 分别跑 V1 / V2 path，断言 MockLLM 接收的 messages 在以下维度语义等价：
   - system prompt 包含相同的核心字段（世界名、玩家信息、locale）
   - 最后一条 user message 相同
   - 历史消息顺序一致
   - 允许段间空白 / 分隔符 / 标点的差异（用 normalize 函数再比较）
4. **测试打开 flag**：`process.env.COVEL_PROMPT_V2 = '1'` + afterEach 清理。
5. **可选**：声明 `authorsNote` / `postHistory` 利用 V2 独有的段 9/10 能力。

### 5.2 同时启用 Prompt Cache

如果已经迁移到 V2，可以进一步打开：

```bash
export COVEL_PROMPT_V2=1
export COVEL_PROMPT_CACHE_V1=1
```

对 Anthropic slot 立刻生效；OpenAI / DeepSeek / Qwen 仍然走 auto-prefix（零改动）。

### 5.3 回滚

任何时候都可以：

- `unset COVEL_PROMPT_V2` → 全局回到 V1
- 单个插件删掉 `promptVersion: 2` → 该插件回到 V1，其他不受影响
- `unset COVEL_PROMPT_CACHE_V1` → cache 注入关闭但 V2 段结构保留

## 6. 已迁移到 V2 的插件清单

| 插件           | Runtime(s)                         | 迁移 commit        | Parity 测试 |
| -------------- | ---------------------------------- | ------------------ | ----------- |
| `narrator`     | (单)                               | Wave B-2 `bbf2889` | 6 cases     |
| `guide`        | (单)                               | Wave B-2 `bbf2889` | 6 cases     |
| `codex`        | (单)                               | Wave C-1           | pending     |
| `char-creator` | `player-init`, `character-tracker` | Wave C-1           | pending     |
| `world-init`   | `schema-gen`                       | Wave C-1 (FU-8)    | —           |
| `pregame`      | (function runtime — 不用 LLM)      | 不适用             | —           |
| `npc-graph`    | —                                  | 未迁移             | —           |

## 7. 相关文件

- `packages/context/src/prompt-assembler.ts` — V2 段组装器
- `packages/context/src/context-builder.ts` — V1/V2 分流入口
- `packages/context/src/budget.ts` — token budget + pruning（段 7 消息裁剪）
- `packages/context/src/compactor.ts` — 长 session 摘要（写入段 7 替换位置）
- `packages/ai-provider/src/adapters/anthropic-messages.ts` — cache_control 注入
- `packages/shared/src/utils/prompt-cache.ts` — PUA sentinel 常量 + 切分 helper
- `packages/plugin-loader/src/parse-plugin-md.ts` — 解析 `promptVersion` / `authorsNote` / `postHistory` 字段
- `packages/shared/src/schemas/plugin.ts` — frontmatter zod schema

## 8. 相关规范文档

- `devs/docs/insights/covel-improvement-plan.md` §A2 — 三段式设计起源
- `devs/docs/insights/covel-improvement-plan.md` §A15 — Prompt cache 抽象
- `devs/docs/insights/covel-improvement-plan.md` §A8 — 向后兼容 / feature flag 策略
- `devs/docs/prompt-externalization-spec.md` — 外部化 prompt markdown 文件规范（`loadPrompt`）
