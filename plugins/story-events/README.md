# story-events

官方维护的可选插件：世界包可以声明「满足条件才发生」的隐藏剧情。条件满足前，剧情内容对模型和玩家都不可见；满足的那一回合，插件把剧情作为一次性提示交给叙事，由叙事自然演出。零依赖、不调用模型。

## 运行时结构

- `evaluate`：pre-turn function runtime。每回合读取隐藏事件、冻结的维度快照（`world.dimensions@1`）和世界时间（`world-time-context@1`），按确定性规则判断，最多揭示一个事件，输出 `story-event-cue@1`。
- `narrator` 与 `chat-mode-narrator` 以可选输入 `storyEvent` 消费该合约；没有启用本插件时输入为空，叙事行为不变。

## 世界包写法

事件必须从 `visibility: hidden` 的 worldData source 导入，否则内容会和普通插件数据一样可见：

```yaml
# data/world.data.yaml
sources:
  storyEvents:
    kind: yaml
    path: data/hidden/events.yaml
    schema: contract:story.events@1
    to: contract:story.events@1
    key: id
    visibility: hidden
```

```yaml
# data/hidden/events.yaml
- id: lighthouse-orphan
  title: { zh-CN: 灯塔托孤, en-US: The Lighthouse Charge }
  when:
    all:
      - time: phase
        in: [3, 4]
      - dimension: location
        equals: lighthouse
      - dimension: reputation
        path: score
        gte: 60
  payload: 守灯的老人把一个孩子交到主角手里……（给叙事的剧情简述，不是成稿）
  once: true
  priority: 10
```

- 条件组合：`all` / `any` / `not`；叶子引用 `dimension`（可带 `path`，点号或数组）或 `time`（world-time 输出的数值字段，如时段制的 `phase` / `cycle`，历法制的 `hour` / `day` / `month` / `weekdayIndex`）。
- 运算符（每个叶子恰好一个）：`equals`、`notEquals`、`in`、`gte`、`gt`、`lte`、`lt`、`exists`。
- 时间请用与语言无关的数值字段；`period` 是本地化文字，不适合写进条件。
- `once` 默认 `true`；可重复事件用 `once: false` + `cooldownTurns`。多个事件同时满足时，`priority` 高者先触发，同级按 ID 排序。
- 引用了不存在的维度或世界时间不可用时，条件视为不满足，原因写进输出的 `diagnostics`（只含 ID，不含剧情内容）。

## 数据与可见性

- 隐藏 source 导入到本插件的保留命名空间 `_hidden.events`。框架保证它不进入提示词、不出现在插件数据 API、数据面板、UI 扩展与模型可用的 plugin-data 工具里，也不能投影进 lorebook。
- 触发时在公开命名空间 `revealed` 写一条揭示记录：事件 ID、可选的公开标题、首次与最近触发回合、次数。记录不包含剧情内容。
- 同一回合重试时重新给出同一条提示，不会重复触发或丢失；整轮执行失败回滚时，揭示记录也不会提交，下回合可再次触发。

## 边界

- 这是「不剧透」，不是加密：世界包文件就在玩家本地，翻文件仍能看到。
- 本期只做确定性条件；需要模型判断的模糊条件、事件链与作者调试视图留作后续。

## 开发与验证

`pnpm --filter @covel/plugin-story-events test` 运行条件判断与选择逻辑的单元测试。
