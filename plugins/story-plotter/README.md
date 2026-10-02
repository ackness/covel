# story-plotter

官方维护的可选插件：在幕后为故事埋下「之后才会发生」的隐藏事件。它每 3 回合读一次剧情，找到正在发展、还没收束的线索（许下的承诺、欠下的债、放过的人、NPC 背着主角做的事），写一条带触发条件的后续事件，交给 [story-events](../story-events/README.md) 保管。条件满足前，玩家和叙事者都看不到它。

需要启用 `story-events`。每次规划调用一次 `plugin` 模型槽。

## 运行时结构

- `plot`：post-turn agent runtime，从第 2 回合起每 3 回合运行一次。输入本回合叙事、维度快照（`world.dimensions@1`）、世界时间（`world-time-context@1`），以及 story-events 的公开账本：已发生事件和已埋下事件的 ID 与标题。世界作者尚未发生的隐藏事件不在其中。
- 工具 `plan-story-events` 把模型提交的 `all` / `none` 条件列表转成 story-events 的条件树，并检查引用的维度、时间字段和事件是否存在；出错时把原因返回给模型修正。成功后输出 `story-event.plan@1`，由 `story-events/intake` 校验入库。
- 每次最多埋 2 个事件，也可以用 `retire` 撤回已经和剧情不符的旧计划，或者提交空计划。
- `plot` 声明 `io.concealed: true`：它的提示词、工具参数和输出不会进入 trace、实时流、`/view` 或 `/turns`。

## 策划约束

- 条件写「现在不成立、剧情顺着发展会成立」的状态，或接在已发生 / 已埋下的事件之后，用 `turnsSinceGte` 留出延迟。
- `payload` 是给叙事者的 2–4 句简述，不写成稿，不替玩家做决定，不揭开世界核心谜底，不让重要角色死亡。
- 计划事件只触发一次，不能覆盖世界作者的事件。

## 开发与验证

`pnpm --filter @covel/plugin-story-plotter test` 运行工具与契约 schema 的单元测试；`apps/server/tests/api/story-events-hidden.test.ts` 覆盖从规划、隐藏存储到揭示的完整链路。
