# story-events

官方维护的可选插件：世界包可以声明「满足条件才发生或解锁」的隐藏剧情、隐藏选项与隐藏奖励。条件满足前，剧情、选项和奖励内容对模型和玩家都不可见；条件支持确定性规则、自然语言语义判断（隐蔽子 Agent）或两者混合。满足后，隐藏剧情作为一次性提示交给叙事，隐藏选项进入玩家可选列表，隐藏奖励按声明原子结算。可选的剧情策划（默认关闭）会调用模型在幕后追加事件。

## 运行时结构

- `evaluate`：`pre-turn` function runtime。每回合读取隐藏条目、冻结的维度快照（`world.dimensions@1`）、世界时间（`world-time-context@1`）、好感档位（`affinity.tier@1`）、背包（`inventory.bag@2`）与行动角色属性：
  - 先检查玩家本回合输入是否精确命中已解锁的隐藏选项（忽略空白与标点）；命中后消耗该选项、将选项的隐藏 `payload` 交给叙事，并结算不要求结果确认的隐藏奖励。
  - 再消费上一回合 `assess` 已「上膛」（`_hidden.armed`）的语义事件，或按确定性条件即时筛选最多一个事件，输出 `story-event-cue@1`。仅当条目显式声明 `timing: pre-turn` 时，才会在本回合提前调用隐蔽 `judge` 子 Agent。
  - 事件揭示后的下一回合，若没有新事件触发，`evaluate` 会把同一事件再交给叙事一次（`cue.reminder: true`），提示语改为「上一回合没写进去就现在写，写过了就接着写后果」。提醒只发一次。
  - 叙事型隐藏奖励或缺少 `inventory` 插件时的降级提示通过 `io.storyContext`（`story-context@1`）提供给叙事。
- `assess`：`audit` function runtime。在 `post-turn` 全部状态（维度、世界时间、好感、背包、WorldIR、叙事文本）结算完成后执行，对首字延迟（TTFT）零开销：
  - 先用四值布尔逻辑（`true` / `false` / `unknown` / `needs_judge`）对所有未完成条目做确定性短路；确定性门控未通过时直接跳过，不调用模型。
  - 经过候选过滤漏斗后，将本回合需要语义判断的 `judge` 叶子（受 `maxJudgedPerTurn` 上限约束）、待确认结果（`requireOutcome: true`）的隐藏奖励，以及玩家改写输入是否匹配当前已解锁隐藏选项的检查，合并为**至多一次**隐蔽 `judge` 子 Agent 调用。
  - 语义条件通过后：故事事件写入 `_hidden.armed`（下回合 `pre-turn` 零延迟揭示）；隐藏选项写入公开 `active_options`（即时呈现在正文下方与舞台选项槽 `stage.choices@1`）；条目级或已选选项的隐藏奖励按声明原子结算。
- `judge`：`subagentOnly: true`、`io.concealed: true` 的只读隐蔽子 Agent（默认使用 `plugin` 模型槽，关闭 reasoning）。仅接收本回合公开证据与筛选后的条件问句，**绝不接收任何隐藏 `payload`、隐藏 `options` 或隐藏 `rewards`**；只有证据确凿（`confidence` 为 `high` 或 `medium`）才判为 `met: true`。
- `narrator` 与 `chat-mode-narrator` 以可选输入 `storyEvent` 消费 `story-event-cue@1`；未启用本插件时输入为空，叙事行为不变。
- `intake`：`post-turn` function runtime。接收在剧情中发布的 `story-event.plan@1` 计划（内置的 `plot` 或其他插件），校验后写入 `_hidden.planned`（见下文「剧情中追加事件」）。
- `plot`：`post-turn` agent runtime，即剧情策划，只在设置 `planner` 开启时运行（见下文「剧情策划」）。
- `evaluate` 输出里的 `ledger` 是给策划者的公开账本：当前回合、已发生事件和已埋下但未发生的计划事件（只有 ID 与公开标题）。世界作者尚未发生的事件不会出现在账本里。
- `evaluate`、`assess`、`judge`、`intake` 与 `plot` 均声明 `io.concealed: true`，它们的提示词、工具参数、结果与输出不会出现在 trace、实时流、`/view` 和执行历史里。

## 玩家界面与设置

- **没有常驻右侧面板**。只在某回合新解锁了隐藏选项或发放了公开隐藏奖励时，正文下方出现轻量消息块（`ui/hidden-unlocks-block.json`）：
  - 在阅读 / 聊天模式下，点击隐藏选项会把选项文本填入输入框（`draftMessage`），方便直接发送或微调；
  - 在舞台模式下，插件通过 `ui.slot@1` 贡献 `stage.choices@1`（`order: 50`），将已解锁的隐藏选项并入舞台底部选项栏，点选即可直接触发。
  - 若玩家改写了隐藏选项的措辞或自行输入同等行动，即使 `pre-turn` 精确匹配未命中，`audit` 阶段的 `judge` 仍可识别意图并补做选项结算。
- 插件设置：
  - `planner`（默认 `false`）：每 3 回合在后台规划后续隐藏剧情。
  - `semanticJudge`（默认 `true`）：允许隐蔽子 Agent 判断自然语言隐藏条件与改写后的隐藏选项。世界包没有写 `judge` 条件、也没有激活隐藏选项时，不会产生任何额外模型调用。
  - `maxJudgedPerTurn`（默认 `8`，范围 `1–16`）：单回合合并送审的自然语言条件上限。

## 世界包写法

隐藏剧情默认放在约定路径 `data/hidden/story-events.yaml`（框架会自动按 `visibility: hidden` 导入，无需额外写 `data/world.data.yaml`）。若需自定义路径，也必须显式声明 `visibility: hidden`：

```yaml
# data/world.data.yaml（仅在不使用约定路径时需要）
sources:
  storyEvents:
    kind: yaml
    path: data/hidden/events.yaml
    schema: contract:story.events@1
    to: contract:story.events@1
    key: id
    visibility: hidden
```

每条记录必须至少包含 `payload`（给叙事的剧情简述，不是成稿）、`options`（解锁后可见的隐藏选项）或 `rewards`（隐藏奖励）三者之一。下面是一个结合确定性门控 + 自然语言语义判断 + 隐藏选项 + 隐藏奖励的混合写法：

```yaml
# data/hidden/story-events.yaml
- id: lighthouse-secret-drawer
  title: 守灯人的暗格
  when:
    all:
      - dimension: location
        equals: lighthouse
      - affinity: 守灯人
        path: tier
        in: [friendly, close, devoted]
      - judge: 主角向守灯人提起旧船单上的编号，或明确追问油灯台底下的夹层
        id: asks-about-ledger-number
        scope: turn
        sticky: true
        watch:
          keywords: [船单, 编号, 油灯台, 夹层]
  options:
    - id: show-salt-receipt
      label: 隐藏行动
      text: 把那张沾着盐渍的旧收据推到油灯底下给他看
      hint: 他的目光在收据编号上停住了
      payload: 守灯人认出收据上的私印，压低声音打开铁盒暗格……（给叙事的剧情简述）
      rewards:
        - id: cistern-brass-key
          kind: item
          title: 蓄水池铜钥匙
          item: 蓄水池铜钥匙
          quantity: 1
          description: 刻着旧潮汐刻度的黄铜钥匙。
          tags: [线索, 钥匙]
        - id: cistern-seal-lore
          kind: lorebook
          title: 潮门暗印记录
          entryId: hidden-cistern-seal
          strategy: selective
          keys: [蓄水池, 旧收据, 潮门]
          content: 这枚私印比封港令早三天，说明当年有人提前改过水位账。
  once: true
  priority: 10
```

每份世界数据文件只写一种语言；译文放在对应语言文件（如 `data/hidden/story-events.en-US.yaml`）中，按 `id` 对齐，见[世界数据的语言文件](../../docs/reference/world-data.md#语言文件namelocaleext)。

### 条件语法（`when`）

- **组合**：`all` / `any` / `not`。
- **自然语言快捷写法**：`when` 可以直接写成字符串（等价于 `{ judge: "<文本>", scope: "turn" }`）。
- **语义判断叶子（`judge`）**：
  - `{ judge: "<自然语言条件>", id?, scope?, sticky?, watch? }`
  - `scope`：`"turn"`（默认，评估本回合玩家输入 + 叙事 + WorldIR）、`"player"`（仅看玩家本回合输入）、`"recent"`（含近期几回合摘要）。
  - `sticky`：默认 `false`；设为 `true` 时，一旦判为成立便记住结果，后续回合不再重复调用模型。
  - `watch`：可选廉价预筛线索，如 `{ keywords: [...], characters: [...], dimensions: [...] }`；有命中时才纳入本回合送审候选，用来进一步节省模型调用。
- **确定性叶子**：
  - `dimension`（可带 `path`，点号或数组）+ 比较运算符
  - `time`（world-time 输出的数值字段，如时段制的 `phase` / `cycle`，历法制的 `hour` / `day` / `month` / `weekdayIndex`）+ 比较运算符（请用与语言无关的数值字段，不要用本地化 `period`）
  - `affinity`（NPC 名字，可选 `path: score | tier`，默认 `score`；读取 `affinity.tier@1`）+ 比较运算符
  - `item`（背包物品名或 ID，支持 `has: true | false` 或 `gte` / `gt` / `lte` / `lt` / `equals` 数量比较；读取 `inventory.bag@2`）
  - `attribute`（行动角色或主角的属性 ID；读取世界角色属性）+ 比较运算符
  - `revealed`（另一个事件 ID，可选 `turnsSinceGte` / `turnsSinceLte`；配合 `not` 可写「某事还没发生」）
  - `selected`（另一个已选择的隐藏选项 ID，可选 `turnsSinceGte` / `turnsSinceLte`）
  - `turnGte` / `turnLte`（会话玩家回合数区间；放进 `not` 表示「到某回合过期」）
- **运算符**（`dimension` / `time` / `affinity` / `attribute` 叶子恰好一个）：`equals`、`notEquals`、`in`、`gte`、`gt`、`lte`、`lt`、`exists`。
- **触发时机与去重**：
  - `timing`：默认 `"post-turn"`（在 `audit` 阶段、回合结束后判定，零首字延迟；语义故事事件上膛后在下回合 `pre-turn` 揭示，隐藏选项与隐藏奖励当回合结束即可见）。若希望本回合立刻根据玩家刚发出的话介入叙事，可显式设 `timing: "pre-turn"`。
  - `once` 默认 `true`；可重复事件用 `once: false` + `cooldownTurns`。
  - `exclusive`：用于互斥组或同一事件下的多个选项；同一条目多个事件同时满足时，`priority` 高者先触发，同级按 ID 排序。
- **四值短路与缺失降级**：
  - 引用不存在的维度、事件 ID，或对应插件（如 `world-time`、`affinity`、`inventory`）未启用时，该叶子为 `unknown`（原因只以 ID 记入 `diagnostics`，不含剧情内容）。
  - `unknown` 不会被 `not` 翻成成立；`all` 中任一确定性分支为 `false` 时立即短路为 `false`（**跳过同一 `all` 里的 `judge` 调用**）；`any` 中任一确定性分支为 `true` 时同样短路（无需调用 `judge`）。整棵树最终为 `unknown` 时视为不满足。

### 隐藏选项（`options`）与隐藏奖励（`rewards`）

- **隐藏选项（`options[]`）**：
  - 每个选项有 `id`、`text`（解锁后展示给玩家的行动文本），可选 `label`、`hint`、`when`（选项自己的额外门控条件）、`payload`（选中后交给叙事的隐藏剧情简述）、`rewards`（选中后发放的隐藏奖励）、`once`（默认 `true`）、`exclusive`（同组互斥）。
  - 未解锁前，`text`、`hint`、`payload` 与 `rewards` 全部留在 `_hidden.events` 内，绝不暴露；解锁后仅把公开字段（`id`、`label`、`text`、`hint`）投影到公开命名空间 `active_options`，隐藏 `payload` 与 `rewards` 直到玩家真正选中时才进入叙事或结算。
- **隐藏奖励（`rewards[]`）**：
  - 支持三种 `kind`：
    - `item`：通过 `inventory.change@1` 写服务原子入包，并对照背包操作账本（`operations@1`）与 `worldIR` 去重，避免重复记账；当会话未启用 `inventory` 插件时自动降级，将获得物品的说明通过 `story-context@1` 交给叙事。
    - `lorebook`：通过内核 `lorebook.upsert` proposal 写入会话设定集（`entryId`、`title`、`content`、`keys`、`strategy`）。
    - `narrative`：写入 `story-context@1` 持久 / 当回合叙事提示，引导叙事兑现隐藏收获。
  - 每个奖励默认在事件触发或选项选中时**确定性原子发放**；作者可按条声明 `requireOutcome: true`（在叙事产出后由 `audit` `judge` 核实故事里确实达成再结算）或 `announce: false`（静默结算，不在正文奖励提示块中展示）。

## 数据与可见性

- 隐藏 source 导入到本插件的保留命名空间 `_hidden.events`。框架保证它不进入提示词、不出现在插件数据 API、数据面板、UI 扩展与模型可用的 plugin-data 工具里，也不能投影进 lorebook。
- 触发、解锁或领奖时，仅在公开命名空间 `revealed`、`active_options`、`selected_options`、`claimed_rewards` 写入不含秘密原文的公开投影或记录；语义判定缓存与上膛队列保存在 `_hidden.judge_cache`、`_hidden.armed`、`_hidden.pending_rewards` 中。
- 同一回合重试时重新给出同一条提示，不会重复触发或重复发奖；整轮执行失败回滚时，揭示记录与奖励提案也会随事务回滚。

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

- 条件写法与世界包确定性条件相同；每份计划最多 3 个事件，同时等待的计划事件最多 8 个。
- 引用的维度、世界时间字段和事件必须存在；不能复用世界作者的事件 ID，也不能改写已经发生的事件。
- 通过的事件写入 `_hidden.planned`，记录来源插件、runtime 和计划回合，只触发一次；`retire` 只能撤回尚未发生的计划事件。
- 校验结果（接受、撤回、拒绝原因）只含事件 ID，不含剧情内容。
- 计划事件和作者事件分属不同的隐藏命名空间，世界数据同步不会覆盖计划事件。

发布计划的 runtime 会接触剧情内容，应声明 `io.concealed: true`。

## 剧情策划

设置 `planner`（默认 `false`）开启内置的 `plot` agent：它从第 2 回合起每 3 回合读一次剧情，找到正在发展、还没收束的线索（许下的承诺、欠下的债、放过的人、NPC 背着主角做的事），写一条带触发条件的后续事件交给 `intake` 保管。每次规划调用一次 `plugin` 模型槽。世界包用 `pluginSettings.story-events.planner: true` 设定默认开启，玩家可在插件设置中改。

- 提示词带世界名称、简介、标签和主角信息；输入本回合叙事、可选的本回合 WorldIR 抽取（`world-ir@2`，有人物、关系、事件和说出口的话时更准确）、维度快照、世界时间，以及 `evaluate` 的公开账本。世界作者尚未发生的隐藏剧情不在其中。
- 工具 `plan-story-events` 把模型提交的 `all` / `none` 条件列表转成条件树。模型能写四种条件：维度字段（`dimension` + `path` + 一个运算符）、世界时间字段（`time` + 一个运算符）、已触发的剧情事件（`revealed`，可带 `turnsSinceGte` / `turnsSinceLte`）和等待（`afterTurns: n`，工具按账本里的当前回合换算成 `turnGte`）。每次最多埋 2 个事件，也可以用 `retire` 撤回已经和剧情不符的旧计划，或者提交空计划。
- 工具对照本次执行的输入检查每个条件，出错时把原因和可用的写法一起返回给模型：引用的维度、时间字段、事件必须存在；对照维度 schema，路径不存在、对非数值字段做数值比较、把整个对象拿去比较、`equals` / `in` 的取值不在枚举里的条件永远不会成立，直接拒绝，不让它占着等待名额；世界时间字段只能和数值比较。
- 几种含义唯一的写法由工具直接整理，不退回模型：单独成条的 `turnsSince*`（并入前一条 `revealed`）、写在事件上而不在 `all` 里的条件、写成 `all` 里一项的 `none`、`payload` 旁多写的 `description`、值为 `null` 的字段、不属于事件的空字符串字段、`notExists`、把运算符和值拆成两个键（`"operator": "gte", "value": 3`）、把世界时间写成 `dimension: worldTime`（字段写在 `time` 或 `path` 下）、把路径写进 `dimension`（`map.hall.status`）或在 `path` 开头重复维度 ID、对只有一个数值字段的对象维度做数值比较时漏写的 `path`。`none` 里引用不存在的事件的条件被去掉：不存在的事件永远不会触发，这个条件不起作用。用已触发事件的 ID 提交的事件是它的后续：已触发的事件不会再排一次，工具给新事件换成下一个空闲 ID（`meg-offer` → `meg-offer-2`）。`reason` 是调试用的说明，可以不写。`events` 里夹着的字符串是模型把结尾写坏留下的碎片（如 `"reason ="`），调用里有事件时直接去掉。
- 条件写「现在不成立、剧情顺着发展会成立」的状态；接在已发生 / 已埋下的事件之后用 `revealed` + `turnsSinceGte`，只想让后果晚几回合出现用 `afterTurns`；`payload` 是给叙事者的 2–4 句简述，不写成稿，不替玩家做决定，不揭开世界核心谜底，不让重要角色死亡。
- 适合线索多、讲后果的世界：调查、地城探险、倒计时救援。作者逐条编排角色路线的恋爱 / 视觉小说世界不建议开启，随手加的事件容易破坏角色和路线节奏。

## 边界

- 这是「不剧透」，不是加密：世界包文件就在玩家本地，翻文件仍能看到；浏览器本地模式的 checkpoint 也包含隐藏数据和计划事件。
- 语义判断优先结合确定性门控或 `watch` 线索使用，避免大量无关条件每回合进入候选池。作者专用调试视图留作后续。

## 开发与验证

`pnpm --filter @covel/plugin-story-events test` 运行确定性/语义四值条件判断、批量送审漏斗、隐藏选项与隐藏奖励结算、以及策划工具的单元测试；`apps/server/tests/api/story-events-hidden.test.ts` 覆盖隐藏存储、规划、隐蔽语义判定、`stage.choices@1` 解锁与背包/设定集原子奖励结算的完整链路。

规划 agent 先成功调用 `plan-story-events`，再用 `{}` 调用 `submit-output`。`io.output.from.tool: plan-story-events` 直接采用已校验的规范事件计划，不需要模型复制；函数 runtime 仍直接返回结果。
