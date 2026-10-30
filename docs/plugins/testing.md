# 插件测试

这一页讲怎样给插件写测试：给工具和函数写单元测试，以及离线用例文件的全部写法。读完之后，你知道每种测试能发现什么、该选哪一种、命令怎么写。

刚开始的话，先读[测试插件](../ship/test.md)。那一页用十分钟带你跑通校验和离线运行；这一页是它的详细版。

所有命令都在 Covel 仓库的根目录运行。

测试维度值超长及修正后的重试。确认失败调用不返回 proposal，版本冲突和意外异常保持原分类，见 [update-dimensions](../reference/tools.md#update-dimensions)。

测试表单工具时，同时断言错误码和失败校验不会发布交互，再用修正后的输入重试。

## 选哪一种测试

从上到下越来越慢，也越来越接近真实的游戏：

| 测试         | 命令                                                  | 能发现什么                                 | 需要服务端或模型密钥吗 |
| ------------ | ----------------------------------------------------- | ------------------------------------------ | ---------------------- |
| 校验         | `pnpm validate:plugin <插件目录>`                     | 配置写错：字段、阶段、工具名、找不到的文件 | 不需要                 |
| 单元测试     | Vitest 加 `@covel/plugin-test-utils`                  | 一个工具或一个函数的逻辑错误               | 不需要                 |
| 离线运行     | `pnpm test:runtime -- <插件 ID>`                      | 插件跑不通：工具没注册、数据没保存         | 不需要                 |
| 真实模型验证 | `pnpm e2e:verify`                                     | 真实的接口、事件流和模型表现               | 需要                   |
| 安装包测试   | `pnpm pack:test-plugin`、`pnpm test:plugin-lifecycle` | 安装、授权、重启、禁用、卸载               | 不需要外部密钥         |

按改动选：

| 你改了什么                                       | 至少跑                                              |
| ------------------------------------------------ | --------------------------------------------------- |
| 只改了 `PLUGIN.md` / `RUNTIME.md`                | 校验                                                |
| 写了工具、函数或 hook 的代码                     | 校验，加单元测试或离线用例                          |
| agent 调用工具的流程、输入、多个 runtime、事件链 | 校验，加离线用例                                    |
| 准备发布                                         | 以上全部，再加[真实模型验证](../ship/real-model.md) |

> [!IMPORTANT]
> 假模型通过，不代表真实模型、授权流程或服务端接口也通过。前三种测试用来快速发现自己的错误，后两种用来确认它在真实环境里能用。

## 校验

```bash
pnpm validate:plugin ~/.covel/plugins/my-plugin
```

参数可以是插件的文件夹、`PLUGIN.md`，或者某个 `runtimes/<名字>/RUNTIME.md`。三种写法都检查整个包。

它检查：

- 每个字段的名字、类型和取值。自动运行的 runtime 没写 `stage` 也会报错。
- 引用的文件是否存在：代码文件、schema、界面文件。
- 内置工具名和自己声明的工具名。
- 输入引用的能力，以及同一个包里 runtime 之间的引用。
- 几个 runtime 之间有没有冲突。

出错时，它给出文件和字段的路径：

```text
✗ [plugin-loader] invalid manifest frontmatter
.../my-plugin/runtimes/analyst/RUNTIME.md: schedule.stage: Invalid option: expected one of "setup"|"pre-turn"|"narrative"|"post-turn"|"audit"; correct this field using the current plugin manifest reference
```

它不做的事：不运行入口文件、guard 和函数。所以“声明了一个工具，但代码里没有注册”它查不出来。这要靠下面两种测试。

## 单元测试

单元测试直接调用你的工具或函数，检查它的返回值。它最快，也最适合测各种边界情况。

### 在哪里能写

用 `pnpm create-plugin <名字> --with-tools` 生成在仓库 `plugins/` 下的插件自带单元测试：`tests/` 里有一个例子，`package.json` 里有 `test` 和 `lint` 两个脚本，还有一个 `vitest.config.ts`。模板与工作区使用同一版 Vitest；升级已有插件时，同步它的开发依赖声明。

生成到用户插件目录的插件不带依赖，也没有测试配置。它们用校验和[离线用例](#离线用例)来测。

运行一个插件的测试：

```bash
pnpm --filter @covel/plugin-my-plugin test
```

> [!NOTE]
> 从插件自己的包运行，不要在仓库根目录用 `pnpm vitest run plugins/<id>/tests`。包里的 `vitest.config.ts` 让每次运行使用自己的临时目录，并在结束时删除；在根目录运行会绕过它。

`pnpm --filter @covel/plugin-my-plugin lint` 用 JSDoc 注释做类型检查，不需要把代码改成 TypeScript。改了调用 SDK 的地方之后，类型检查和测试都跑一遍。

模板使用稳定版 TypeScript 7.0.2；试用 TypeScript 7.1 时，开发环境中的 Zod 也必须满足 SDK 的 4.6.7 最低版本。不要用类型断言或关闭检查来绕过旧版 Zod 的递归 JSON 类型错误。

### 测一个工具

工具是一个接收帮手的函数。测试里把帮手传给它，再直接调用 `execute`：

```js
import { expect, it } from "vitest";
import {
  getPendingProposals,
  getToolContent,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import { tool, z } from "@covel/tools";
import makeSaveNote from "../tools/save-note.js";

const saveNote = makeSaveNote({ tool, z, withPendingProposals });
const ctx = {
  sessionId: "session",
  turnId: "turn",
  pluginId: "notebook",
  runtimeId: "notebook",
};

it("returns one plugin.data proposal", async () => {
  const result = await saveNote.execute(
    { id: "gate-is-locked", text: "The north gate is locked." },
    ctx,
  );

  expect(getToolContent(result)).toEqual({ saved: true, id: "gate-is-locked" });
  expect(getPendingProposals(result)[0]).toMatchObject({
    type: "plugin.data",
    payload: { namespace: "notes", key: "gate-is-locked" },
  });
});
```

工具的返回值有两部分。用 `getToolContent(result)` 取“返回给模型的内容”，用 `getPendingProposals(result)` 取“想写入的数据”。不要把整个返回值当成业务内容来断言。

### 测一个工具，并且真的保存

上面的测试只看工具返回了什么。想确认这些写入真的能通过检查并保存下来，用 `executeToolAndCommit`。它用一个内存里的存档，走和游戏里相同的执行和保存流程：

```js
import {
  createPluginTestStore,
  executeToolAndCommit,
} from "@covel/plugin-test-utils";

it("commits the note", async () => {
  const store = await createPluginTestStore(ctx);

  await executeToolAndCommit(
    saveNote,
    { id: "gate-is-locked", text: "The north gate is locked." },
    ctx,
    store,
  );

  const row = await store.getPluginData(
    "session",
    "notebook",
    "notes",
    "gate-is-locked",
  );
  expect(row?.value).toEqual({
    id: "gate-is-locked",
    text: "The north gate is locked.",
  });
});

it("rejects an empty id", async () => {
  const store = await createPluginTestStore(ctx);

  await expect(
    executeToolAndCommit(saveNote, { id: "", text: "x" }, ctx, store),
  ).rejects.toThrow("Tool parameter validation failed");
});
```

- 参数不符合工具的 `parameters` 时，调用被拒绝，什么都不保存。
- 写入不合法时（例如写进以 `_` 开头的数据空间），保存失败，并且整次执行的写入都撤销。
- 要测同一次执行里的多次写入，先分别调用工具，再用 `commitToolResults([first, second], ctx, store)` 一次保存。
- 它不包含服务端接口、授权和事件目录。那些边界由服务端的测试和真实模型验证覆盖。

### 测一个函数

`makeManualFunctionContext` 造出一个函数需要的 `ctx`。你只需要提供这个测试会用到的部分：

```js
import { expect, it } from "vitest";
import { makeManualFunctionContext } from "@covel/plugin-test-utils";
import handler from "../runtimes/note/handler.js";

it("writes one note", async () => {
  const saved = new Map();
  const ctx = makeManualFunctionContext({
    pluginId: "my-plugin",
    manualPayload: { title: "Gate", text: "The gate is locked." },
    pluginData: {
      get: async (namespace, key) => saved.get(`${namespace}/${key}`) ?? null,
      set: async (namespace, key, value) => {
        saved.set(`${namespace}/${key}`, value);
      },
    },
  });

  const result = await handler(ctx);

  expect(result.outcome).toBe("success");
  expect(result.value.note.title).toBe("Gate");
  expect(saved.size).toBe(1);
});
```

要点：

- 它不模拟保存。你传进去的 `pluginData`、`world`、`tools`、`images`、`signal`、`triggerEvent` 会原样交给函数。
- 没有提供的 `ctx.store` 读取方法，一调用就报错，例如 `store.getPluginData is not configured for this test context`。这样测试不会悄悄读到空数据。
- 默认带一个固定的 `ctx.random`，每次运行给出相同的数。所以掷骰的结果可以直接断言。
- 调用子 agent 的函数传 `subagents`：一串按顺序使用的结果，或一个按请求返回结果的函数。不传时 `ctx.agents` 不存在。要断言发出的请求，用 `makeScriptedAgents(results)`，它返回 `{ agents, requests }`。
- 函数返回的效果在 `result.effects` 里，例如 `result.effects.interactions`。
- 同时生成模型指令和玩家可见数据的函数，要交叉测试内容语言与 `COVEL_INSTRUCTION_LOCALE`，至少覆盖中文内容配英文指令、英文内容配中文指令。直接调用真实 handler，分别断言指令语言和结果数据；缺值时检查可选字段确实省略。用 `vi.stubEnv` 设置覆盖值，并在 `afterEach` 调用 `vi.unstubAllEnvs` 恢复环境。例子见[骰子判定测试](../../plugins/dice-check/tests/roller.test.js)。语言规则见[多语言参考](../reference/i18n.md#2-本地化插件)。

### 工具包里有什么

`@covel/plugin-test-utils` 的导出：

<!-- prettier-ignore -->
| 导出                                                                   | 用途                                                                       |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `makeManualFunctionContext`                                            | 造一个函数用的 `ctx`                                                       |
| `makeRandom(seed?)`                                                    | 测试用的 `ctx.random`。手写 `ctx` 的测试自己放进去                         |
| `makeScriptedAgents(results)` | 测试用的 `ctx.agents`：按脚本回答 `ctx.agents.run`，并记下每次请求 |
| `loadPluginMessages(pluginRoot, locale)`                               | 读取插件 `locales/` 里的译文，得到 `ctx.messages`。要断言中文输出时用它    |
| `createPluginTestStore` / `executeToolAndCommit` / `commitToolResults` | 让工具走真实的执行和保存流程                                               |
| `MockLLM`                                                              | 假模型。记录每次调用；支持一个默认回复和一串按顺序使用的回复               |
| `makeTurnInput` / `makeTriggerContext` / `makeRuntimeResult`           | 少写一些测试数据。`makeTurnInput` 默认带 `locale: "zh-CN"`，和真实游戏一致 |
| `expectAssetGenerated`                                                 | 断言结果的 `effects.assetGenerations` 里有一个合法的媒体引用               |

`makeRandom().int(min, max)` 与宿主共用参数检查，范围错误抛相同的 `RangeError`，无论游戏是否设置种子。检查规则见 [`ctx.random`](../reference/plugins.md#随机数ctxrandom)。

可以照着写的真实测试：

- 函数：[`plugins/character-blueprint/tests/presence.test.js`](../../plugins/character-blueprint/tests/presence.test.js)
- 由事件触发的函数：[`plugins/scene-stage/tests/handler.test.js`](../../plugins/scene-stage/tests/handler.test.js)
- 生成媒体：[`packages/plugin-handlers-utils/tests/image-generation.test.ts`](../../packages/plugin-handlers-utils/tests/image-generation.test.ts)

### 在测试里跑完整的一个回合

绝大多数情况用下一节的离线用例就够了。只有需要在 Vitest 里精确控制每一步（例如事件链里的每个 runtime）时，才自己组装一个回合：

1. 用 `@covel/plugin-loader` 的 `discoverPlugins` / `loadPluginDefinition` / `loadRuntime` 加载真实的插件。
2. 用 `@covel/store/memory` 的 `createMemoryStore` 做存档。
3. 用 `@covel/runtime` 的 `createToolExecutor` 和 `executeTurn` 执行，模型用 `MockLLM`。
4. 把 `executeTurn` 返回的整个 `{ result, commit }` 交给 `commitExecution` 保存。不要自己拆开逐条写入。

现成的组装在 [`packages/test-runtime/src/execution.ts`](../../packages/test-runtime/src/execution.ts)。事件链的例子：[`scene-stage-integration.test.ts`](../../packages/runtime/tests/scene-stage-integration.test.ts) 和 [`emit-event-integration.test.ts`](../../packages/runtime/tests/emit-event-integration.test.ts)。执行和保存的边界见[协议参考](../reference/protocol.md#宿主执行与提交边界)。

<a id="coveltest-runtime"></a>

## 离线用例

`pnpm test:runtime` 真的运行你的插件，只是把模型换成假的。它用和游戏相同的执行和保存流程：设置项的默认值、工具权限、时限都一样，失败的写入不会留下。

### 两种目标

```bash
# Run every case in the plugin's case file
pnpm test:runtime -- my-plugin --pretty

# Trigger one runtime directly, without a case file
pnpm test:runtime -- my-plugin/note --payload '{"title":"Gate"}' --pretty
```

| 目标                  | 做什么                                                                    |
| --------------------- | ------------------------------------------------------------------------- |
| `<插件 ID>`           | 运行 `tests/runtime-cases.json`（或包根目录的 `covel.test.json`）里的用例 |
| `<插件 ID>/<runtime>` | 手动触发这一个 runtime，适合临时调试                                      |

没有用例文件时：只有一个 runtime 的插件会被假模型运行一次，只确认它能加载和执行；多 runtime 的插件会报 `has no tests/runtime-cases.json or covel.test.json`。

插件从哪里找，按这个顺序：`--plugins-dir`、环境变量 `COVEL_USER_PLUGINS_DIR`、`$COVEL_HOME/plugins`、`~/.covel/plugins`。测仓库里的插件时加 `--plugins-dir plugins`。

### 用例文件

文件可以是用例数组，或 `{ "$schema": "…", "cases": [...] }`。每个用例必须有非空的 `name` 和 `runtimeId`。`mode` 只接受 `mock`、`live`、`both`；省略时为 `both`。顶层、用例、`expect` 和 `artifacts` 中的未知字段都会报错，错误带文件名和字段路径；例如 `expects` 或 `expect.runtimeResult` 不会被忽略。插件定义的 payload、设置和模拟回复对象仍可使用自己的字段。

脚手架生成的文件带 `$schema`，编辑器可按 [runtime-cases.schema.json](../../packages/shared/schemas/runtime-cases.schema.json) 提示字段。修改用例后重新运行，校验失败时不会开始执行 runtime。

```json
{
  "$schema": "https://raw.githubusercontent.com/AcKnEsS/covel/main/packages/shared/schemas/runtime-cases.schema.json",
  "cases": [
    {
      "name": "manual-note-writes-plugin-data",
      "runtimeId": "my-plugin/note",
      "payload": { "title": "Test checkpoint" },
      "expect": {
        "runtimeResults": [
          { "runtimeId": "my-plugin/note", "status": "success" }
        ],
        "pluginData": [{ "namespace": "notes", "field": "title" }],
        "logs": ["note.recorded"]
      }
    }
  ]
}
```

一个用例的字段：

| 字段                        | 意思                                                             |
| --------------------------- | ---------------------------------------------------------------- |
| `name`                      | 用例的名字。`--case <name>` 只运行它                             |
| `runtimeId`                 | 要运行哪个 runtime。只有一个 runtime 的插件，它的名字就是插件 ID |
| `message`                   | 玩家这一回合的输入                                               |
| `payload`                   | 手动触发时传给 runtime 的数据，函数里是 `ctx.manualPayload`      |
| `userSettings`              | 覆盖这个插件的设置项。不写时用声明的默认值                       |
| `llmResponses`              | 假模型的回复，一次模型调用用掉一个                               |
| `llmResponse`               | 只有一个回复时的简写                                             |
| `llmContent` / `llmObject`  | 更短的简写：回复是一段文字，或者一个 JSON 对象                   |
| `withPlugins`               | 一起加载的其他插件，见[和别的插件一起测](#和别的插件一起测)      |
| `ignoreUpstreams`           | 忽略这个 runtime 对上游的依赖，只为了单独调试它                  |
| `expectsBackgroundFollower` | 期望这次运行会排出一个后台任务。没有排出就算失败                 |
| `mode`                      | `mock`、`live` 或 `both`（默认）。这个用例在哪种模式下运行       |
| `expect`                    | 运行之后应该成立的事                                             |
| `artifacts.saveImages`      | 把生成的图片存到一个目录，方便人看                               |

> [!NOTE]
> 用例里的 runtime 是被直接触发的，它的上游并没有运行。所以它声明的输入（例如这一回合的故事正文）是空的，`message` 只是玩家输入。要测“读到上游结果之后做什么”，在测试里[组装完整的回合](#在测试里跑完整的一个回合)。`withPlugins` 只加载其他插件，不会自动运行它们的上游 runtime。

### 假模型的回复

一个回复就是模型的一次回答。让它调用工具：

```json
{
  "content": null,
  "finishReason": "tool_calls",
  "toolCalls": [
    {
      "id": "tc-1",
      "name": "save-note",
      "arguments": "{\"id\":\"gate-is-locked\",\"text\":\"The north gate is locked.\"}"
    }
  ]
}
```

- `arguments` 是一段 JSON 文本，所以里面的引号要加反斜杠。
- 模型分几步完成时，在 `llmResponses` 里按顺序写几个回复。
- 默认的假模型不会自己编出工具调用。声明了“必须调用工具”（`completion.require: tool-use`）的 agent 一定要在用例里提供回复，否则运行失败。

### 可以期望什么

| `expect` 里的字段  | 检查什么                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `runtimeResults`   | 某个 runtime 以某个状态结束。`runtimeId` 可省略；`errorIncludes` 检查错误信息里含有一段文字 |
| `pluginData`       | 某个数据空间里有记录。可以再指定 `key`，以及记录里必须有的 `field`                          |
| `events`           | 发出了这些名字的事件                                                                        |
| `logs`             | 插件日志里有这些消息                                                                        |
| `assetGenerations` | 生成了媒体。可以指定 `modality`                                                             |

期望一次失败也是可以的：

```json
"expect": {
  "runtimeResults": [
    { "runtimeId": "my-plugin/note", "status": "failed", "errorIncludes": "requires" }
  ]
}
```

这时只有这个 runtime 的这次失败被接受。保存失败和其他意外的失败仍然让用例失败。

### 读结果

输出是一份 JSON。每个用例有一个 `status`，下面的 `assertions` 逐条列出哪条期望成立：

```json
"assertions": [
  { "status": "passed", "message": "runtime:notebook:success" },
  { "status": "failed", "message": "pluginData:notes" }
]
```

有一个用例失败，命令就以非零的退出码结束。不用用例、直接触发一个 runtime 时也一样：保存失败、runtime 失败或后台任务失败都会让命令失败。

结果里几个有用的字段：

| 字段                           | 意思                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `runtimeResults`               | 每个运行过的 runtime 的状态、输出和工具调用                                              |
| `commitStatus` / `commitError` | 这次执行有没有保存成功                                                                   |
| `pluginData`                   | 运行之后，被测插件的数据                                                                 |
| `llmCalls`                     | 每次模型调用用了哪个用途、能用哪些工具。加 `--show-prompts` 还能看到发给模型的完整提示词 |
| `jobs` / `deferredFollowers`   | 这次运行排出的后台任务及其结果                                                           |
| `pendingDeferredFollowers`     | 后台任务又排出的任务。离线运行不会执行它们                                               |
| `unsupportedCapabilities`      | 插件注册了、但离线运行不支持的东西                                                       |

结果是 `skipped: upstream not success` 时，说明这个 runtime 因为上游没成功而被跳过，它本身并没有运行。

### 常用参数

| 参数                                               | 作用                           |
| -------------------------------------------------- | ------------------------------ |
| `--plugins-dir <path>`                             | 从哪个目录找插件               |
| `--case <name>`                                    | 只运行一个用例                 |
| `--with-plugin <id>`                               | 一起加载另一个插件。可以写多次 |
| `--message <text>`                                 | 玩家输入                       |
| `--payload <json>`                                 | 手动触发时传的数据             |
| `--user-settings <json>`                           | 覆盖被测插件的设置项           |
| `--llm-content <text>`                             | 假模型回复一段文字             |
| `--llm-object <json>`                              | 假模型回复一个 JSON 对象       |
| `--llm-response <json>` / `--llm-responses <json>` | 完整的假模型回复，一个或一串   |
| `--locale <locale>`                                | 这一局的语言，默认 `zh-CN`     |
| `--ignore-upstreams`                               | 忽略对上游的依赖               |
| `--expects-background-follower`                    | 没有排出后台任务就算失败       |
| `--show-prompts`                                   | 在结果里包含发给模型的消息     |
| `--mode <mock\|live>` / `--live`                   | 用假模型还是真实模型           |
| `--pretty`                                         | 把 JSON 排版成多行             |

### 和别的插件一起测

默认只加载被测的插件。需要另一个插件配合时（例如调用它的服务），显式加上：

```bash
pnpm test:runtime -- lifecycle-probe/note \
  --plugins-dir tests/third-party \
  --with-plugin service-provider-probe \
  --payload '{"text":"Hello","providerPluginId":"service-provider-probe"}' \
  --pretty
```

- 一起加载的插件从同一个 `--plugins-dir` 里找。找不到会在运行任何代码之前报错。
- 加载不等于运行。只有你指定的目标被触发；别的插件的 runtime 只在收到它们监听的事件时运行。
- 所以依赖上游结果的 runtime 仍然拿不到结果。只想调试不依赖上游的那部分时，用 `--ignore-upstreams`。
- 结果里的 `pluginData` 仍然只有被测插件的数据。`userSettings` 也只覆盖被测插件，别的插件用自己的默认值。

> [!WARNING]
> 这条命令会运行这些插件的服务端代码，而且不经过授权。只对你信任的本地插件用它。

### 它测不到什么

离线运行会真的运行入口文件，注册工具和服务，也会运行回合里的 hook。下面这些需要完整的服务端，离线运行不支持：

- 动作（RPC）、表单校验器、媒体协议（wire）。
- 会话开始和结束、压缩前后的 hook。
- `history.compact@2`、`ui.slot@1`、`media.image-flow@1` 这几个扩展点。

插件注册了它们时，命令会打印一条警告，并把它们列进结果的 `unsupportedCapabilities`：

```text
[test-runtime] Unsupported rpc: notebook/inspect-note. Verify with the server.
```

另外：

- 它只执行这一次运行和它直接排出的后台任务，不运行长期的任务队列。
- 真实的模型服务商、授权、暂停后恢复、多级的后台调度，都要用[真实模型验证](../ship/real-model.md)或浏览器测试。

### 用真实模型运行用例

```bash
pnpm test:runtime -- my-plugin --case happy-path --mode live --pretty
```

> [!CAUTION]
> `--mode live` 会请求真实的模型服务商，可能产生费用。没有密钥时留在默认的假模型模式。不要把密钥写进仓库。

它按这个顺序找模型配置：环境变量 `COVEL_LLM_TOML` 指向的文件、`$COVEL_HOME/llm.toml`、当前目录的 `llm.toml`。密钥从 `$COVEL_HOME/keys.env` 读取，已有的同名环境变量优先。没有设置 `COVEL_HOME` 时用 `~/.covel`。

它**不会**自动读取仓库根目录的 `.env` 和 `.env.llm`，这一点和开发服务端不同。要用仓库根目录的配置，显式加载：

```bash
COVEL_LLM_TOML=llm.toml pnpm exec tsx \
  --env-file-if-exists=.env --env-file-if-exists=.env.llm \
  packages/test-runtime/src/cli.ts my-plugin --case happy-path --mode live --pretty
```

这种模式适合发布前人工看一遍。自动化检查用假模型。

## 安装包和玩家流程

想看一个真正独立的社区插件怎样被完整测试，参考仓库里的 [`tests/third-party/lifecycle-probe`](../../tests/third-party/lifecycle-probe/README.md)。它有自己的 ID 和版本，通过真实的安装接口装进一个临时的用户插件目录，按社区插件的身份加载，不借用内置插件的信任。

```bash
pnpm pack:test-plugin        # writes test-results/lifecycle-probe.zip
pnpm test:plugin-lifecycle
```

这组测试覆盖安装、重复导入、授权、重启后重新发现、运行、禁用、卸载和重新安装，以及失败之后数据撤销。

这些自动测试用的都是固定的模型回复。改动涉及玩家流程时，发布前还要在正式构建上用真实模型玩一遍，见[浏览器测试 · 发版前的玩家流程验收](../internals/e2e-testing.md#发版前的玩家流程验收)。

自己的插件怎样打包、试装，见[打包并试装](../ship/package.md)。

## 一个新功能该测什么

- **正常情况**：给出合法的输入，得到期望的输出和数据。
- **不合法的输入**：缺字段、类型不对、超出范围。应该被拒绝，并且什么都不保存。
- **没有数据**：数据空间是空的、这一回合没有相关内容。
- **重复调用**：同一个操作执行两次，结果仍然正确。
- **数据归属**：只写自己的数据空间；写入请求里的插件 ID 是自己的。
- **失败不留痕迹**：运行失败之后，没有保存下半截数据。
- **先写后读**：同一次运行里，后一步能读到前一步写的内容。

改角色的工具，用真实的角色字段定义来检查，不要自己写一份简化的。

## 没有按预期工作时

| 现象                                                         | 原因和处理                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `has no tests/runtime-cases.json or covel.test.json`         | 多 runtime 的插件没有用例文件。加一个，或者写完整的 runtime 名来直接触发                    |
| 用例 `failed`，`assertions` 里是 `pluginData:<名字>`         | 数据没有按期望保存。核对用例里的 `namespace`、`key`、`field`                                |
| 用例 `failed`，`assertions` 里是 `runtime:<名字>:success`    | runtime 没有成功。看 `runtimeResults` 里它的 `error`                                        |
| `skipped: upstream not success`                              | 它依赖的上游没有运行。只测本地逻辑可加 `--ignore-upstreams`；要读真实上游结果则组装完整回合 |
| 声明了必须调用工具的 agent 失败                              | 用例没有提供带工具调用的 `llmResponses`                                                     |
| 工具调用被拒绝                                               | 假回复里的 `arguments` 不符合工具的参数，或者不是合法的 JSON 文本                           |
| 打印 `Unsupported rpc` 之类的警告                            | 正常。这部分要在真实的服务端上验证                                                          |
| 单元测试里 `store.… is not configured for this test context` | 函数读了你没有提供的数据。在 `makeManualFunctionContext` 的 `store` 里补上                  |
| 找不到插件                                                   | 插件不在默认目录里。加 `--plugins-dir`                                                      |

## 接下来

- [用真实模型验证](../ship/real-model.md)
- [打包并试装](../ship/package.md)
- 给 AI 助手用的测试模板：[`.claude/skills/create-plugin/references/plugin-testing.md`](../../.claude/skills/create-plugin/references/plugin-testing.md)
