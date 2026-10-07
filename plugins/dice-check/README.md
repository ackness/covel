# dice-check

骰子判定（零 LLM）。"我尝试撬锁"成不成，不再由叙事 LLM 自由心证：每回合预先掷好骰池注入叙事引擎，叙事按规则用骰并发事件回执，玩家在消息里看到可视化的 🎲 判定结果——成败有规则、有随机性、可审计。

## 运行时结构

- `PLUGIN.md`：包级摘要与 server entry，注册玩家侧掷骰 action。
- `rpc/roll.js`：`/roll [notation]`（别名 `/r`）命令处理器；接受 1-100 颗、2-1000 面的 `NdM` 骰式，缺省为 `1d20`。
- `runtimes/roller/`：pre-turn function runtime，每回合用 `node:crypto` 预掷 3 个 d20，输出 `checkContext`（每次判定一行的结果表 + 判定规则 markdown）供叙事引擎注入。表里每个难度一列，直接给出结果或“修正达到多少为成功”，叙事查表即可，不做加法。玩家角色有量程的数值属性的修正也由 roller 按量程预换算（(数值 − 下限) ÷ 量程 × 10）列在块里，叙事读取而不自行估算；无量程的属性才由叙事换算。
- `hooks/verify-check-receipt.js`：`PreToolUse` 守卫，在叙事发出回执时对照骰子。
- `lib/check-rules.js`：判定规则（难度对应的 DC、成败与大成功/大失败），roller、守卫和 recorder 共用。
- `runtimes/recorder/`：event function runtime，订阅 `check.resolved` 回执并落库。
- `schemas/check-resolved.event.json`：判定回执 payload schema（emit-event 按它校验）。payload 是批量形（`{ checks: [...] }`，1-3 项）——`emit-event` 对同 topic 每回合去重，逐次发射会丢第二条，因此整回合的判定合并进一次发射。
- `runtimes/recorder/ui/check-message.json`：消息区判定结果块（🎲 行动 → 骰式 → 成败配色，critical 强调）。
- `runtimes/recorder/ui/checks-panel.json`：右侧「判定记录」面板（倒序），提供 d20 / 2d6 快速按钮；按钮通过 JSON-RENDER `invokeCommand` 复用 `/roll`，不另建 action 旁路。

## 数据与行为

- 骰池通过 roller 的 `dice` runtime output 在同回合绑定给 recorder（`inputs.dicePool`），同时把审计轨写入 `plugin_data[dice-check][rolls]`（key = turnId，`{ dice: [n1, n2, n3] }`）；后者到 turn finalizer 才提交，供事后审计与重试兜底。
- 玩家从输入框执行 `/roll` 或点击快速掷骰按钮，都会归一化为同一个 `dice-check:roll` 命令并由 RPC 返回结果；命令生命周期写入统一 `command.*` trace，但不写入 `rolls` namespace，避免与回合预掷审计轨混用。
- 判定回执写入 `plugin_data[dice-check][checks]`（key = `<turnId>-<序号>`，含展示字段）。
- 本回合判定数组写入 `plugin_data[dice-check][message]`（key = turnId，值带 `__turnId`，消息层 block 数据源）。
- 回执只含叙事自己决定的内容：`action`、`attribute`、`modifier`、`difficulty`，以及它写出的 `outcome`。骰子不在回执里：第一项用本回合第一颗骰，第二项用第二颗，叙事无法挑骰。DC、合计与真实结果由 `lib/check-rules.js` 计算；`outcome` 与骰子给出的结果不一致的项不落库（它的骰子仍算已用），有效项照常落库，缺少预掷审计轨时整体 fail-closed。
- 叙事在写正文之前发出回执。本插件的 `PreToolUse` 守卫（`hooks/verify-check-receipt.js`）在发出当场对照骰子：结果不符就退回，并在退回消息里给出每次判定的正确结果，叙事据此重发，再按真实结果写正文。守卫用的是 roller 留在进程内的骰子副本（`lib/turn-pool.js`）；副本不在时守卫放行，仍由 recorder 在回合末校验。
- 若同一执行的可选 `tabletop-check@1` 输入已有本回合表单回执，表单检定由 tabletop-rules 独占，recorder 整批跳过模型发出的 `check.resolved`，不再把独立掷出的表单骰当作本插件的骰池。下一无表单回执的普通回合仍照常校验和记账。

## 集成

本插件通过 `action-check@1` 契约向叙事引擎提供 `checkContext`：本回合骰池，加上完整的判定规则与回执要求。契约只承诺这一个字段；输出里的 `dice` 是 recorder 同回合读取的包内私有字段。

叙事引擎（narrator / chat-mode-narrator）接入只需两步，自身不写任何骰子规则：

1. 根 `optional` 声明 `action-check@1`，并在 `io.inputs` 按契约绑定 `checkContext`：

   ```yaml
   check-results:
     from:
       contract: action-check@1
     select: /checkContext
     required: false
   ```

2. 正文只约定「该输入存在时严格按其中的规则判定并提交它要求的回执，不存在时按一般叙事处理」，并声明 `emit-event` 工具与 `advertiseEvents: true`，让 `check.resolved` 的事件目录出现在 prompt 里。

有 `tabletopCheck.value` 表单回执时，`checkContext` 自带的规则会让出本回合，叙事只叙述该已结算结果。

### 替换判定系统

规则文本全部由提供者生成，所以换一套判定系统（d100、2d6 分档、成功数骰池等）不需要改叙事引擎：另写一个插件提供 `action-check@1`，在 `checkContext` 里给出自己的资源、规则和回执要求，并声明自己的回执事件与 UI。`check.resolved` 事件与「判定记录」面板属于本插件，不是契约的一部分。

## 开发

修改掷骰规则、回执 schema、展示字段或 UI spec 后，运行本包测试。

Invalid automatic receipts are reported as failed runtime tasks and remain visible in the execution timeline. No unverifiable check is stored. If a batch contains both valid and invalid receipts, the message identifies that some checks were rejected and displays only audited results. Manual `/roll` results are separate from automatic checks.
