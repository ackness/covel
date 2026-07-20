# Prompt 结构参考

Covel 当前使用单一路径组装 runtime context：`buildContext()` / `buildContextAsync()` 都委托给 `packages/context/src/prompt-assembler.ts` 的 segment-based assembler。早期的版本切换环境变量、版本选择 frontmatter、prompt cache 开关和 parity 迁移路径已移除。

## 1. 构建入口

| 入口                            | 用途                                                                        |
| ------------------------------- | --------------------------------------------------------------------------- |
| `buildContext(params)`          | 同步组装普通 runtime context。                                              |
| `buildContextAsync(params)`     | 语义相同，额外解析 `input.inject[].kind === "plugin-data"`，需要 store IO。 |
| `needsAsyncBuild({ manifest })` | 由调用方判断是否需要 async 路径。                                           |

`ContextBuildParams` 中的 `estimator + contextBudget` 决定是否执行 history pruning。没有这两个参数时，assembler 只做组装，不做 token 预算裁剪。

## 2. 段位图

```text
system prompt
  [1] Framework Preamble
  [2] Core Memory + Working Memory
  [3] Plugin Instructions
  [4] WorldInfo: before-plugin
  [5] Injects from upstream
  [6] WorldInfo: after-plugin

messages
  [7] Message history after summary substitution and pruning
  [8] WorldInfo / persona at-depth contributions
  [9] Author's Note
  [10] Post-History Instructions
```

| #   | 名称                         | 来源                                                                                                                                                                                | 输出位置        |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1   | Framework Preamble           | locale、运行框架约束                                                                                                                                                                | `systemPrompt`  |
| 2   | Core Memory + Working Memory | session context snapshot                                                                                                                                                            | `systemPrompt`  |
| 3   | Plugin Instructions          | `PLUGIN.md` 正文 + persona contributions                                                                                                                                            | `systemPrompt`  |
| 4   | WorldInfo before-plugin      | session context contributions                                                                                                                                                       | `systemPrompt`  |
| 5   | Upstream Injects             | `manifest.input.inject`；`manifest.advertiseEvents: true` 时追加 `<available-events>` 事件目录（opt-in，见 [plugins.md](./plugins.md#events-声明与-advertiseevents统一事件发射层)） | `systemPrompt`  |
| 6   | WorldInfo after-plugin       | session context contributions                                                                                                                                                       | `systemPrompt`  |
| 7   | Message history              | store 中的 turn messages + compactor summaries                                                                                                                                      | `messages`      |
| 8   | At-depth contributions       | session context contributions                                                                                                                                                       | `messages`      |
| 9   | Author's Note                | 当前执行 runtime 的 `authorsNote`                                                                                                                                                   | `messages`      |
| 10  | Post-History Instructions    | 当前执行 runtime 的 `postHistory`                                                                                                                                                   | `messages` 末尾 |

空段会被跳过，非空 system 段用 `\n\n` 拼接成 `AssembledContext.systemPrompt`。运行时仍消费一个 `systemPrompt: string` 与一个 `messages` 数组。

## 3. 插件扩展点

插件可以在 `PLUGIN.md` frontmatter 声明 `authorsNote` 和 `postHistory`：

```yaml
---
name: narrator

authorsNote:
  content: |
    请以第三人称叙述，但在关键转折时给出角色的内心独白。
    当前导演目标: {{ story.flags.currentGoal }}
  depth: 4
  role: system

postHistory:
  content: |
    输出必须包含 <narrative> 标签和 <choices> 标签。
  role: system

summaryFocus:
  - "主角的情绪线"
  - "当前目标进度"
---
```

合并规则：

- **作用域是「当前执行的 runtime 自己」**，不聚合 session 内其他插件。`postHistory` 是 runtime 的私有工作指令（它的工具流程、终止契约），跨插件聚合会把一个插件的内部指令塞进另一个插件的 system prompt——既是插件隔离泄露，也让无关插件能操纵一个作者从未选择接受它的 runtime。`ContextBuildParams.activeManifests` 参数保留复数形态是因为 builder 本身通用，调用方若确实需要可以自行传入一组；框架的回合路径只传当前 runtime 的（locale 解析后的）manifest。
- 传入多个 manifest 时按 `RuntimeManifest.priority` 升序合并。
- 相同 `(role, depth)` 的 `authorsNote` 用空行合并成一条消息。
- 不同 depth 的 `authorsNote` 分别插入到对应历史位置。
- `postHistory` 按 role 分组，相同 role 合并后追加到消息末尾。

## 4. Template 变量

`PLUGIN.md` 正文、`authorsNote.content`、`postHistory.content`、runtime inject 内容都支持 `{{ variable }}` 插值。变量来自 `assemblePromptVariables()`：

- `{{ player.message }}`：当前玩家输入。
- `{{ player.lastFormValues }}`：最近一次 player 表单提交，JSON 字符串。
- `{{ session.id }}` / `{{ session.turnNumber }}`。
- `{{ inputs.<pluginId>.<runtimeId>.<field> }}`：上游 runtime 输出。
- `{{ world.* }}`：由 session context snapshot 的 `world` 视图提供，例如 `world.schema`、`world.entries`、`world.dimensions`。
- `{{ userSettings.* }}`：玩家配置的插件设置。

Working Memory 与 Core Memory 通过 session context snapshot 进入段 2；插件模板也可以通过已有变量读取需要暴露的字段。

## 5. Prompt Cache 标记

`serializeSystemPrompt(segments, true)` 默认在可缓存 system 段后插入内部 PUA sentinel (`\uE000`)：

1. 段 1：Framework Preamble
2. 段 3：Plugin Instructions
3. 段 6：WorldInfo after-plugin

Anthropic adapter 会把 sentinel 转成 `cache_control: { type: "ephemeral" }` 的 text block。OpenAI-compatible providers 不读取 sentinel，依赖 provider 的自动前缀匹配。

## 6. `prompts/server`

`prompts/server` 是服务端外置 prompt 模板目录，当前使用路径：

- `compactor.zh.md` / `compactor.en.md`：`packages/context/src/compactor.ts` 通过 `loadPrompt("server", "compactor", locale)` 加载。
- `generate-world.md`：`packages/create/src/prompts.ts` 通过 `loadPrompt("server", "generate-world")` 加载。

Prompt 根目录由 `COVEL_PROMPTS_DIR` 覆盖；未设置时 `prompts-loader` 会从包路径向上查找仓库根目录下的 `prompts/`。

## 7. 相关实现

- `packages/context/src/context-builder.ts`：公共入口，负责保持 `buildContext` API 稳定。
- `packages/context/src/prompt-assembler.ts`：segment-based context assembler。
- `packages/context/src/prompt-internals.ts`：插值、inject、变量对象、memory 渲染。
- `packages/context/src/prompt-serialization.ts`：system 段拼接与 prompt-cache sentinel。
- `packages/context/src/budget.ts`：message history token 预算裁剪。
- `packages/context/src/compactor.ts`：长 session 摘要与 summary substitution。
- `packages/context/src/session-context.ts`：session-level context snapshot 构建。
