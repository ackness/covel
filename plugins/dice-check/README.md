# dice-check

骰子判定（零 LLM）。"我尝试撬锁"成不成，不再由叙事 LLM 自由心证：每回合预先掷好骰池注入叙事引擎，叙事按规则用骰并发事件回执，玩家在消息里看到可视化的 🎲 判定结果——成败有规则、有随机性、可审计。

## 运行时结构

- `PLUGIN.md`：包级摘要（非 runtime）。
- `runtimes/roller/`：pre-turn function runtime，每回合用 `node:crypto` 预掷 3 个 d20，输出 `checkContext`（骰池 + 判定规则 markdown）供叙事引擎注入。
- `runtimes/recorder/`：event function runtime，订阅 `check.resolved` 回执并落库。
- `schemas/check-resolved.event.json`：判定回执 payload schema（emit-event 按它校验）。payload 是批量形（`{ checks: [...] }`，1-3 项）——`emit-event` 对同 topic 每回合去重，逐次发射会丢第二条，因此整回合的判定合并进一次发射。
- `runtimes/recorder/ui/check-message.json`：消息区判定结果块（🎲 行动 → 骰式 → 成败配色，critical 强调）。
- `runtimes/recorder/ui/checks-panel.json`：右侧「判定记录」面板（倒序）。

## 数据与行为

- 骰池审计轨写入 `plugin_data[dice-check][rolls]`（key = turnId，`{ dice: [n1, n2, n3] }`）。
- 判定回执写入 `plugin_data[dice-check][checks]`（key = `<turnId>-<序号>`，含展示字段）。
- 本回合判定数组写入 `plugin_data[dice-check][message]`（key = turnId，值带 `__turnId`，消息层 block 数据源）。
- 回执批量逐项校验：无效项跳过、有效项照常落库，全部无效才整体 skip，不影响回合。

## 集成

叙事引擎（narrator / chat-mode-narrator）需要两处配合（本插件不改它们的文件）：

1. frontmatter `input.inject` 追加一条，消费 roller 的 `checkContext`：

   ```yaml
   - kind: runtime
     from: dice-check/roller
     field: checkContext
     as: "<check-results>"
   ```

2. 正文追加「判定规则使用」段落：何时判定、如何用骰池与属性修正、整回合判定完成后经 emit-event **一次性**发 `check.resolved` 批量回执（叙事引擎已声明 `advertiseEvents: true` 时，事件目录会自动出现在 prompt 里）。

## 开发

修改掷骰规则、回执 schema、展示字段或 UI spec 后，运行本包测试。
