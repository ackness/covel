# memory

插件持有核心记忆的定义、提取、提示词渲染和面板。内核只提供数据事务、服务网关、扩展点和脱离回合的任务调度。

## 运行时结构

- `PLUGIN.md` 注册 `memory.block-definitions@1` 服务、`prompt.segment@1` 扩展和面板。
- `runtimes/extract/RUNTIME.md` 在 `post-turn` 消费冻结的 `turn-digest@1`，以脱离回合的 function runtime 提取记忆。
- `server/extract.js` 使用当前请求的 gateway 和 `plugin` 模型槽，写入自己的 `blocks` 命名空间。

## 数据与行为

下一次执行等待已入队的提取任务提交，然后捕获新的插件数据快照。等待超时不取消任务；禁用插件后不再等待它，也不注入其记忆。失败或取消的提取不会提交部分记忆。

`player_profile` 的确定性身份行来自权威 World Model，动态状态由模型维护。插件可以通过 `memory.block-definitions@1` 提供额外标签。世界数据使用 `memory.blocks@1` 契约，记录形状为 `{id: "world", blocks: [...]}`，写入本插件 `definitions/world`。默认标签不可被外部定义替换。

提示词内容经过 XML 转义，作为 `audience: story`、`volatility: turn` 的片段放在缓存边界之后。最多展示 60 个块，正文共享 8192 字符预算。

旧开发数据中的 `working_memory`、内核提取队列和镜像数据不再读取；升级后应重建开发会话。

## 验证

运行 `pnpm --filter @covel/plugin-memory test`。服务端 `memory-detached-lifecycle.test.ts` 覆盖原请求服务、提交屏障、新执行快照和禁用插件的行为。
