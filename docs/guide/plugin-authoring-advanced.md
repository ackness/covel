# 插件开发指南 · 多 Runtime、契约与发布

根 `PLUGIN.md` 是包级契约，子 `RUNTIME.md` 是执行契约。加载器的内部执行字段不属于作者接口。完整字段和默认提供者规则见[插件契约参考](../reference/plugins.md)。

## 多 Runtime 布局

```text
fact-index/
├── package.json
├── README.md
├── PLUGIN.md
├── server/index.js
├── schemas/facts.schema.json
└── runtimes/
    ├── extract/RUNTIME.md
    └── query/
        ├── RUNTIME.md
        └── handler.js
```

根文件：

```yaml
---
id: fact-index
kind: plugin
description: Extracts and retrieves narrative facts.
provides: [facts.index@1, facts.query@1]
requires: [narrative-engine@1]
contributes:
  data:
    facts:
      version: 1
      accepts: [facts.index@1]
      schema: ./schemas/facts.schema.json
---
```

namespace 接收 `facts.index@1`，它的 `schema` 就是这个契约的公共 schema，不需要在根 `contracts` 里再写一遍。只有不被任何 namespace 接收的契约（例如 runtime 的输出契约）才写 `contracts.<id>.schema`。

`runtimes/extract/RUNTIME.md`：

```yaml
---
type: agent
schedule: { stage: post-turn }
io:
  inputs:
    narrative:
      from: { contract: narrative-engine@1 }
      required: true
      select: /narrativeOutput
  output:
    contract: facts.index@1
    schema: ../../schemas/facts.schema.json
    recordAs: extracted-facts
agent: { model: plugin }
---
Extract only facts supported by runtime-inputs.narrative.value.
```

`runtimes/query/RUNTIME.md`：

```yaml
---
type: function
schedule:
  trigger: { type: manual }
  manual: { execution: sync }
io:
  output: { contract: facts.query@1 }
function:
  handler: ./handler.js
  timeoutMs: 90000
---
```

子 runtime 的 schema、handler、guard 路径相对其目录，根贡献路径相对包根。路径和符号链接不能逃出包。子 runtime 不接受 `contributes`、包身份、旧 `name` 或旧根字段；root 的设置和数据上下文由加载器显式提供，不合并多个来源。

## 数据契约与世界导入

`contracts` 定义 schema，`contributes.data.<namespace>.accepts` 声明接收哪些版本化数据契约。接收 schema 路径需与契约声明一致。相同契约的多个提供者必须使用一致 schema，冲突在加载或导入前报错。

接收世界数据的 namespace 应同时声明 `authoring`，告诉世界作者怎么提供这份内容：

```yaml
contributes:
  data:
    facts:
      version: 1
      schema: ./schemas/facts.schema.json
      accepts: [facts.index@1]
      authoring:
        title: Known facts
        hint: >-
          Write one record for each fact the story starts with. Keep `text` to
          one sentence.
        example: ./examples/facts.json
        source:
          kind: yaml
          path: data/facts.yaml
          key: id
```

`title` 是标签，主清单里写 English；中文写在 `locales/zh.yaml`：

```yaml
PLUGIN.md:
  contributes:
    data:
      facts:
        authoring:
          title: 已知事实
```

- `title` 是给作者看的内容名称；`hint` 说明怎么写好这类记录，用简短明确的英文句子。
- `summary` 是给玩家看的一句话简介，支持多语言；应用内创作界面用它作为选项说明。
- `example` 指向一份合法示例（JSON）。它按 namespace 的 schema 校验，`pnpm describe:authoring --check` 和仓库测试都会检查。
- `source` 是这份内容在世界包里的约定来源：`kind`、`path`、`key`，以及可选的 `visibility: hidden` 和 `lorebook: true`。媒体目录用 `kind: media`。世界包把文件放在这个 `path` 上就会被导入，不需要 descriptor；两个契约声明了同一个 `path` 时这个路径不算约定，所以选一个别的插件不会用的路径。
- `generate` 声明应用内的世界生成器可以只凭 `hint` 和 `example` 生成这份内容：`offer` 把它列为创作界面里的可选项，`default` 列出并默认选中。它要求有 `example`，并且 `source` 是公开的、非媒体的、以 `id` 为 key 的来源。玩家选中后，生成器会把这个契约的 schema、提示和示例写进提示词，并把接收插件加入世界的 `pluginPolicy.requested`。只有在真实模型上验证过生成质量的内容才应声明它。

`pnpm describe:authoring` 会把这些声明汇总成每种内容的路径、写法和示例（以及等价的 descriptor 条目），世界创作 skill 和应用内生成器读的是同一份数据。新插件声明了 `authoring`，就不需要再去修改中心文档或 skill。字段表见 [Plugin manifest 字段表](../reference/schema/plugin-manifest.md)。

世界来源使用 `to: contract:facts.index@1`（`schema` 省略时就是目标契约的 schema），框架按当前活动插件声明分发。插件的私有 namespace 不作为跨插件 API，也不再使用 `plugin:<id>/<namespace>` 作为作者导入目标。投影通过根 `contributes.worldProjections` 声明，输出必须对应可导入的数据 namespace。详见[世界数据参考](../reference/world-data.md)。

角色蓝图等业务格式由其插件拥有。框架处理通用 source/target 和 CharacterSchema/CharacterRecord，不按具体插件 ID 包装数据或制造角色镜像。

## 服务与扩展

服务是插件主动调用的公开 API，扩展是内核在固定阶段请求插件提供内容或策略的入口。两者均使用版本化契约、schema 校验、归属和执行快照。

- 根 `contributes.services` 对应 `registerService`。
- 根 `contributes.extensions` 对应 `provideExtension(point, id, ...)`。
- 注册名称必须与清单双向匹配。
- 静态 `contributes.prompt` 由宿主自动注册，不重复声明 `static-prompt`。
- 多个 runtime 的局部提示词规则写在各自正文，包级静态段对整个插件生效。

扩展 handler 的准确输入、输出、合并规则和错误语义见[插件扩展点参考](../reference/plugin-extensions.md)。不要自行增加内核分支或读取其他插件私有 namespace 来模拟公开扩展。

## 后台工作与失败

后台 function runtime 使用 `schedule.manual.execution: background`，事件 runtime 使用 `schedule.trigger: {type: event, topic: ...}`。`schedule.completion` 描述回合等待语义；不是所有组合都允许 detached，需通过当前 manifest 和运行时准入校验。

Function 通过 `function.tools` 声明 `ctx.tools.call` 的白名单，不能额外声明 `agent` 组。外部 API 的超时放在 `function.timeoutMs`，agent 的步数、调用超时和重试放在 `agent.loop`：`timeoutMs`、`callTimeoutMs`（不流式的调用）、`maxRetries`（默认 1）、`firstTokenTimeoutMs` 与 `idleTimeoutMs`（流式调用，默认 120 秒；没有显式设置时，首次输出的等待会缩短到给剩余重试留出时间）、`loopDetection`（默认 3），语义见[插件契约参考](../reference/plugins.md)。保持任务取消、错误结果、幂等与提交边界明确。仅把合法结果返回 proposal 管线；执行失败不能留下部分业务写入。

网络调用使用 SDK 提供的受约束工具与 URL 验证；不要把任意玩家 URL 直接交给后端抓取。权限、审批与资源限额仍由宿主执行，作者声明不等于授予权限。

## Hook

Hook 只守卫、改写或审计，不放玩法逻辑。根 `contributes.hooks` 列出事件，entry 用 `covel.on(event, handler)` 注册；两边必须一致。handler 是 `async (ctx, payload) => result`：

```js
export default function (covel) {
  covel.on("PreToolUse", async (ctx, payload) => {
    if (ctx.runtimeId !== "my-plugin/tracker") return { action: "continue" };
    if (payload.toolCall.name !== "delete-note") return { action: "continue" };
    return { action: "abort", reason: "This runtime may not delete notes." };
  });
}
```

事件说的是哪个 runtime，在上下文里读：`ctx.pluginId` 和 `ctx.runtimeId`；载荷不再重复它们（读 `payload.runtimeId` 永远匹配不到，handler 什么也不做）。`ctx.locale` 是会话的内容语言，hook 往提示词里加文字时用 `instructionLocaleFor(ctx.locale)` 选语言，不要从提示词文字猜。事件列表、载荷、可返回的结果和失败处理见 [Hooks 参考](../reference/hooks.md)。

## 世界模型与记忆

`ctx.world` 是执行视图，包含 committed 状态和合法上游及当前 proposals。角色 schema 变更与角色写入走同一领域校验。不得把上游 proposals 复制到本 runtime 的提交缓冲。

记忆块是 memory 插件的数据和服务；世界自定义块通过 `memory.blocks@1` 导入，默认定义由 `memory.block-definitions@1` 服务提供。历史压缩经 `history.compact@2` 扩展处理。框架不会读取 `memoryBlocks/summaryFocus` 作者字段或维护独立 working_memory 数据。

## 本地化与加载快照

canonical 正文是 English；中文变体为根 `PLUGIN.zh.md` 和子 runtime 的 `RUNTIME.zh.md`，其他语言的变体文件不被读取。变体可以省略不翻译的结构，loader 会从 canonical 继承；结构漂移被报告并保持 canonical 值。提示词段 ID、position、runtime 输入、工具和超时均属于结构。

静态提示词语言版本在插件加载时捕获，执行期间不读磁盘。热重载替换后，新执行看到新定义，已开始的执行继续使用其捕获版本。不要在扩展 handler 内重新解析 manifest。

## 测试与发布

```sh
pnpm validate:plugin plugins/fact-index
pnpm validate:plugin plugins/fact-index/runtimes/query/RUNTIME.md
pnpm --filter @covel/plugin-fact-index test
pnpm lint
pnpm test
```

测试重点是 schema 边界、数据归属、重复调用、失败后无部分提交，以及同一执行的写后读。UI spec 只能绑定所属插件的数据或动作；外部数据通过公开契约转换为自己的投影。

README 应说明玩家可见行为、输入/输出契约、设置、权限、运行时组成和测试方式。`package.json` 应声明真实依赖，保持 ESM 和 NodeNext 路径约定，不提交密钥、生成数据或机器路径。发布与安装流程见[插件安装](../reference/plugin-installation.md)。
