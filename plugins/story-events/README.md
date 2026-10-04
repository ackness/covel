# story-events

官方维护的可选插件：世界包可以声明「满足条件才发生」的隐藏剧情。条件满足前，剧情内容对模型和玩家都不可见；满足的那一回合，插件把剧情作为一次性提示交给叙事，由叙事自然演出。判断与揭示零依赖、不调用模型；可选的剧情策划（默认关闭）会调用模型在幕后追加事件。

## 运行时结构

- `evaluate`：pre-turn function runtime。每回合读取隐藏事件、冻结的维度快照（`world.dimensions@1`）和世界时间（`world-time-context@1`），按确定性规则判断，最多揭示一个事件，输出 `story-event-cue@1`。
- `narrator` 与 `chat-mode-narrator` 以可选输入 `storyEvent` 消费该合约；没有启用本插件时输入为空，叙事行为不变。
- `intake`：post-turn function runtime。接收在剧情中发布的 `story-event.plan@1` 计划（内置的 `plot` 或其他插件），校验后写入 `_hidden.planned`（见下文「剧情中追加事件」）。
- `plot`：post-turn agent runtime，即剧情策划，只在设置 `planner` 开启时运行（见下文「剧情策划」）。
- `evaluate` 输出里的 `ledger` 是给策划者的公开账本：当前回合、已发生事件和已埋下但未发生的计划事件（只有 ID 与公开标题）。世界作者尚未发生的事件不会出现在账本里。
- `evaluate`、`intake` 与 `plot` 都声明 `io.concealed: true`，它们的输出不会出现在 trace、实时流和执行历史里。

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

- 条件组合：`all` / `any` / `not`；叶子引用 `dimension`（可带 `path`，点号或数组）、`time`（world-time 输出的数值字段，如时段制的 `phase` / `cycle`，历法制的 `hour` / `day` / `month` / `weekdayIndex`）或 `revealed`（另一个事件）。
- 事件链：`{ revealed: <事件 ID> }` 在该事件发生过后成立，可加 `turnsSinceGte` / `turnsSinceLte` 限定距它最近一次发生过了多少回合；配合 `not` 可以写「某事还没发生」。`revealed` 叶子不需要比较运算符，引用不存在的事件 ID 属于无法判断（见下）并写入诊断；事件存在但尚未发生则是确定的“不成立”，`not` 可以正常取反。

```yaml
- id: fangs-collect
  when:
    all:
      - revealed: meg-shows-the-fragment
        turnsSinceGte: 3
      - dimension: factionStanding
        path: saltFangs.attitude
        lte: 0
  payload: 盐牙会派人来讨账……
```

- 运算符（`dimension` / `time` 叶子恰好一个）：`equals`、`notEquals`、`in`、`gte`、`gt`、`lte`、`lt`、`exists`。
- 时间请用与语言无关的数值字段；`period` 是本地化文字，不适合写进条件。
- `once` 默认 `true`；可重复事件用 `once: false` + `cooldownTurns`。多个事件同时满足时，`priority` 高者先触发，同级按 ID 排序。
- 引用了不存在的维度、不存在的事件 ID，或世界时间不可用时，该叶子**无法判断**，原因写进输出的 `diagnostics`（只含 ID，不含剧情内容）。无法判断不会被 `not` 翻转成满足；`any` 仍可凭其他成立的分支成立，`all` 仍因任一不成立的分支不成立；整棵条件最终无法判断时视为不满足。

## 数据与可见性

- 隐藏 source 导入到本插件的保留命名空间 `_hidden.events`。框架保证它不进入提示词、不出现在插件数据 API、数据面板、UI 扩展与模型可用的 plugin-data 工具里，也不能投影进 lorebook。
- 触发时在公开命名空间 `revealed` 写一条揭示记录：事件 ID、可选的公开标题、首次与最近触发回合、次数。记录不包含剧情内容。
- 同一回合重试时重新给出同一条提示，不会重复触发或丢失；整轮执行失败回滚时，揭示记录也不会提交，下回合可再次触发。

## 剧情中追加事件

任何 runtime 都可以在 post-turn 发布 `story-event.plan@1` 输出（例如本插件的 `plot`），本插件的 `intake` 在同一回合接收：

```json
{
  "events": [
    {
      "id": "salt-fangs-collect",
      "title": "盐牙讨账",
      "when": {
        "all": [{ "revealed": "meg-shows-the-fragment", "turnsSinceGte": 3 }]
      },
      "payload": "两个盐牙会的人在主角的住处门口等着……"
    }
  ],
  "retire": ["dock-fire"],
  "reason": "铁姑的条件被拒绝了"
}
```

- 条件写法与世界包事件相同；每份计划最多 3 个事件，同时等待的计划事件最多 8 个。
- 引用的维度、世界时间字段和事件必须存在；不能复用世界作者的事件 ID，也不能改写已经发生的事件。
- 通过的事件写入 `_hidden.planned`，记录来源插件、runtime 和计划回合，只触发一次；`retire` 只能撤回尚未发生的计划事件。
- 校验结果（接受、撤回、拒绝原因）只含事件 ID，不含剧情内容。
- 计划事件和作者事件分属不同的隐藏命名空间，世界数据同步不会覆盖计划事件。

发布计划的 runtime 会接触剧情内容，应声明 `io.concealed: true`。

## 剧情策划

设置 `planner`（默认 `false`）开启内置的 `plot` agent：它从第 2 回合起每 3 回合读一次剧情，找到正在发展、还没收束的线索（许下的承诺、欠下的债、放过的人、NPC 背着主角做的事），写一条带触发条件的后续事件交给 `intake` 保管。每次规划调用一次 `plugin` 模型槽。世界包用 `pluginSettings.story-events.planner: true` 设定默认开启，玩家可在插件设置中改。

- 提示词带世界名称、简介、标签和主角信息；输入本回合叙事、可选的本回合 WorldIR 抽取（`world-ir-provider@1`，有人物、关系、事件和说出口的话时更准确）、维度快照、世界时间，以及 `evaluate` 的公开账本。世界作者尚未发生的隐藏事件不在其中。
- 工具 `plan-story-events` 把模型提交的 `all` / `none` 条件列表转成条件树，并检查引用的维度、时间字段和事件是否存在；出错时把原因返回给模型修正。每次最多埋 2 个事件，也可以用 `retire` 撤回已经和剧情不符的旧计划，或者提交空计划。
- 条件写「现在不成立、剧情顺着发展会成立」的状态，或接在已发生 / 已埋下的事件之后，用 `turnsSinceGte` 留出延迟；`payload` 是给叙事者的 2–4 句简述，不写成稿，不替玩家做决定，不揭开世界核心谜底，不让重要角色死亡。
- 适合线索多、讲后果的世界：调查、地城探险、倒计时救援。作者逐条编排角色路线的恋爱 / 视觉小说世界不建议开启，随手加的事件容易破坏角色和路线节奏。
- 条件只能引用维度和世界时间，好感度等插件数据不能直接作为条件。

## 边界

- 这是「不剧透」，不是加密：世界包文件就在玩家本地，翻文件仍能看到；浏览器本地模式的 checkpoint 也包含隐藏数据和计划事件。
- 目前只做确定性条件；需要模型判断的模糊条件和作者调试视图留作后续。

## 开发与验证

`pnpm --filter @covel/plugin-story-events test` 运行条件判断、选择逻辑与策划工具的单元测试；`apps/server/tests/api/story-events-hidden.test.ts` 覆盖从规划、隐藏存储到揭示的完整链路。
