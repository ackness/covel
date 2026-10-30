# 插件测试指引

给 `create-plugin` 生成插件后的 agent 用。优先写能稳定证明行为的最小测试；不要把 live provider 当 CI 门禁。

| 层                 | 工具                                        | 速度                            | 何时必须                                                         |
| ------------------ | ------------------------------------------- | ------------------------------- | ---------------------------------------------------------------- |
| L1 Schema          | `validatePluginManifest`                    | 即时                            | 每个 `PLUGIN.md`                                                 |
| L2 单元            | Vitest + `@covel/plugin-test-utils`         | <1s                             | 写了 `tools/*.js`、`handler.js`、`hooks/*.js`                    |
| L3 In-process turn | 手搓 turn-executor + `MockLLM`              | 1-3s                            | agent runtime、tool loop、`input.inject`、多 runtime/event 链    |
| L4 Runtime cases   | `pnpm test:runtime` (`@covel/test-runtime`) | 1-10s mock / 真实 provider 更慢 | 第三方插件、手动 runtime、后台 follower、外部 `~/.covel/plugins` |
| L5 HTTP E2E        | `scripts/e2e-plugin-verify.ts`              | 30s+                            | 发布前验证 API/SSE/store/approval 全链路                         |

默认规则：

- L1 每次都跑。
- L2/L3 使用 mock，不需要真实 provider key。
- L4 mock 可进 CI；L4 live 和 L5 放发布前人工验证。
- 涉及图片/音频/视频时，测试 MediaRef 与 `assetGenerations[]`，不要断言 bytes/base64 写进 plugin-data。

---

## L1 — Schema 校验

用仓库自带的校验脚本，别手搓——它一次跑完两道校验（strict package/runtime authoring schema），传插件目录时会自动遍历 `runtimes/*/RUNTIME.md`：

```bash
pnpm validate:plugin plugins/<id>          # 整个插件（含全部子 runtime）
pnpm validate:plugin plugins/<id>/PLUGIN.md # 单份 manifest
pnpm validate:plugin ~/.covel/plugins/<id>  # 仓库外插件，绝对路径即可
```

失败输出会指名违规字段并给替代写法，例如：

```
Fix: `tools.local` was removed — register the tool in the plugin's `entry`
     module (`covel.registerTool`) and list its NAME under `tools.plugin`.
```

> 别改写成 `node -e "... import { validatePluginManifest } from '@covel/shared'"`：workspace 包直接导出 TS 源码（无构建产物），裸 `node` 会在解析 `@covel/shared` 时抛 `ERR_MODULE_NOT_FOUND`。`validate:plugin` 走的是 `tsx`。
>
> 静态校验不会执行 entry。工具、RPC、服务等注册还要和 `contributes` 双向一致；用注册测试和真实加载检查，不能从 manifest 校验成功推断 entry 已能运行。

---

## L2 — 单元测试

适用对象：

- `tools/*.js` / `tools/*.ts`
- function runtime（有 `function` 块）的 `handler.js`
- `hooks/*.js`
- provider wire helper（建议放 `lib/*.js`）
- trigger / guard helper

### 测 local tool

```js
import { describe, expect, it } from "vitest";
import { getPendingProposals } from "@covel/plugin-handlers-utils";
import createMyTool from "../tools/my-tool.js";

describe("my-tool", () => {
  it("emits one plugin-data proposal", async () => {
    const myTool = createMyTool();
    const ctx = {
      sessionId: "sess-1",
      pluginId: "my-plugin",
      runtimeId: "my-plugin",
      turnId: "turn-1",
      store: {},
    };

    const result = await myTool.execute({ name: "foo", value: 42 }, ctx);
    const proposals = getPendingProposals(result);

    expect(proposals).toHaveLength(1);
    expect(proposals[0].type).toBe("plugin.data");
  });
});
```

如果工具直接返回业务 JSON，不走 `withPendingProposals(...)`，就直接断言返回值。

### 测 function runtime handler

`makeManualFunctionContext` 只提供通用字段。使用 `ctx.gateway`、`ctx.media`、`ctx.utils`、`ctx.pluginData`、`ctx.logger` 时，在测试里用 object spread 补齐 mock。

```js
import { describe, expect, it, vi } from "vitest";
import { makeManualFunctionContext } from "@covel/plugin-test-utils";
import handler from "../runtimes/image-generator/handler.js";

describe("image-generator handler", () => {
  it("resolves image slot and returns MediaRef asset", async () => {
    const mediaRef = {
      id: "a".repeat(64),
      mime: "image/png",
      size: 123,
    };
    const ctx = {
      ...makeManualFunctionContext({
        pluginId: "my-plugin",
        runtimeId: "my-plugin/image-generator",
        manualPayload: { prompt: "a quiet harbor" },
      }),
      images: {
        isAvailable: vi.fn().mockReturnValue(true),
        generate: vi.fn().mockResolvedValue({
          refs: [mediaRef],
          warnings: [],
          cached: false,
        }),
      },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    };

    const result = await handler(ctx);

    expect(ctx.images.generate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "a quiet harbor" }),
    );
    expect(result.outcome).toBe("success");
    expect(result.effects.pluginData[0].namespace).toBe("images");
    expect(result.effects.assetGenerations[0]).toMatchObject({
      ref: mediaRef,
      modality: "image",
    });
  });
});
```

### 测 trigger helper

测试自己的触发 helper 时，用 `makeTriggerContext({ logicalTurn, turnNumber })` 明确设定时钟。框架的 `schedule.every: 3` 在逻辑回合 3、6、9 运行，不是 1、4、7；setup、开场和第一条玩家消息的逻辑回合都为 1。若业务规则使用另一种节奏，测试要说明这个区别。

`makeTriggerContext` 的默认 `turnsSinceLastTrigger: 999` 不能替代首次运行、冷却边界和已提交 trigger 台账的测试。调度规则以[触发方式](../../../../docs/reference/plugins.md#触发方式)为准。

---

## L3 — 手搓 turn-executor + `MockLLM`

> 旧的 `createTestHarness` 已退役（功能不足：无法注入合成 runtime，也不 commit proposal）。需要 in-process 跑完整 turn 时，用 `@covel/runtime` 公开导出手工组装；多数插件级需求优先走 L4（`pnpm test:runtime`）。

组装步骤（完整可运行范例：`packages/runtime/tests/scene-stage-integration.test.ts` 与 `packages/runtime/tests/emit-event-integration.test.ts`）：

1. `discoverPlugins` / `loadPluginManifest` / `loadRuntime`（`@covel/plugin-loader`）加载真实插件 runtime；需要合成 runtime（如模拟 narrator 发 event）时手写 `RuntimeManifest` + `LLMAdapter`。
2. `createMemoryStore()`（`@covel/store`）做后端，按需 `setPluginData` 预置数据。
3. `createToolExecutor` + `executeTurn`（`@covel/runtime`）执行 turn，LLM 用 `MockLLM`（`responses[]` 按调用顺序消费，耗尽后回落 `defaultResponse`，多步 tool loop 优先用它）。
4. 把 `executeTurn` 返回的整个 `{ result, commit }` 交给 `commitExecution`（`@covel/runtime`），确认提交成功，再断言 `store.listPluginData(...)` 等持久化结果。不要逐条提交 runtime result：嵌套结果、journal、挂起、setup 和时钟必须共用完整提交计划，见[宿主执行与提交边界](../../../../docs/reference/protocol.md#宿主执行与提交边界)。

常用断言：

| 目标                  | 写法                                                    |
| --------------------- | ------------------------------------------------------- |
| prompt 里包含注入内容 | `llm.calls[n].messages`                                 |
| 工具顺序              | `execution.result.runtimeResults[0].toolCalls.map((c) => c.name)` |
| plugin_data 写入      | `store.listPluginData(sessionId, pluginId, namespace)`  |
| asset.generate 输出   | `expectAssetGenerated(result, { modality: "image" })`   |

---

## L4 — `@covel/test-runtime`

用于插件作者从 CLI 调试真实插件包，尤其是 `~/.covel/plugins` 下的第三方插件。它使用同一套 in-process runtime kernel，支持 mock/live provider、后台 follower、`_jobs`、`_logs`、plugin-data 报告和图片 artifact 导出。

### 命令

```bash
# 跑插件声明的 cases
pnpm test:runtime -- my-plugin --plugins-dir plugins --pretty

# 跑外部插件声明的 cases
pnpm test:runtime -- my-plugin --plugins-dir ~/.covel/plugins --pretty

# 只跑一个 case
pnpm test:runtime -- my-plugin \
  --plugins-dir ~/.covel/plugins \
  --case manual-note-writes-plugin-data \
  --pretty

# 直接调试一个 runtime
pnpm test:runtime -- my-plugin/manual-runtime \
  --plugins-dir ~/.covel/plugins \
  --payload '{"title":"Debug","text":"hello"}' \
  --pretty

# live provider
pnpm test:runtime -- my-plugin \
  --plugins-dir ~/.covel/plugins \
  --case image-live \
  --mode live \
  --pretty
```

### CLI 选项

| Option                           | 用途                                                                    |
| -------------------------------- | ----------------------------------------------------------------------- |
| `--plugins-dir <path>`           | 插件根目录；默认 `~/.covel/plugins` 或 `COVEL_USER_PLUGINS_DIR`         |
| `--plugin <id>`                  | runtime-id 模式下显式指定 plugin id                                     |
| `--case <name>`                  | plugin-id 模式下只跑一个 case                                           |
| `--mode <mock\|live>` / `--live` | mock provider 或真实 `llm.toml`/API key                                 |
| `--payload <json>`               | 注入 `ctx.manualPayload`                                                |
| `--config <json>`                | `getConfig()` 返回值                                                    |
| `--user-settings <json>`         | 当前插件的 `ctx.userSettings` bucket                                    |
| `--llm-content <text>`           | mock agent runtime 的最终文本                                           |
| `--llm-object <json>`            | 自动 stringify 的 mock JSON 文本                                        |
| `--llm-response <json>`          | 完整 mock LLM response                                                  |
| `--llm-responses <json>`         | 多次 LLM 调用脚本，按顺序消费                                           |
| `--mock-preset-id <id>`          | mock `resolveSlot()` 暴露的 synthetic preset id                         |
| `--show-prompts`                 | 输出捕获的 LLM messages                                                 |
| `--ignore-upstreams`             | 本次调试运行清空该 runtime 的 `needs` 门控                              |
| `--expects-background-follower`  | 没有 deferred follower 时写一个 failed `_jobs` 行，便于 UI 可见失败断言 |
| `--pretty`                       | 格式化 JSON 输出                                                        |

### `tests/runtime-cases.json`

`@covel/test-runtime` 自动寻找：

1. `tests/runtime-cases.json`
2. `covel.test.json`

文件可以是 `{ "$schema": "…", "cases": [...] }` 或直接数组。严格 schema 位于 `packages/shared/src/schemas/runtime-cases.ts`，编辑器用的 JSON Schema 位于 `packages/shared/schemas/runtime-cases.schema.json`。`name` 和 `runtimeId` 必须非空，`mode` 只接受 `mock`、`live`、`both`。未知的用例、期望和 artifact 字段会带文件名和字段路径报错，不会忽略拼错的断言。

```json
{
  "cases": [
    {
      "name": "manual-note-writes-plugin-data",
      "runtimeId": "my-plugin/note",
      "message": "optional player message",
      "payload": {
        "title": "Test checkpoint",
        "text": "The runtime records deterministic plugin state."
      },
      "userSettings": {
        "enabled": true
      },
      "llmResponses": [
        {
          "content": null,
          "finishReason": "tool_calls",
          "toolCalls": [
            {
              "id": "tc-runtime-done",
              "name": "runtime-done",
              "arguments": "{\"reason\":\"recorded\"}"
            }
          ],
          "usage": { "inputTokens": 1, "outputTokens": 1 }
        }
      ],
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

支持的 `expect`：

| 字段                 | 断言                                          |
| -------------------- | --------------------------------------------- |
| `runtimeResults[]`   | runtime id、status、`errorIncludes`           |
| `events[]`           | runtime output events topic                   |
| `logs[]`             | `_logs` namespace 中的 `message`              |
| `pluginData[]`       | namespace/key/status/field                    |
| `assetGenerations[]` | output `assetGenerations[]` 的 modality/field |

### Expected failure

mock 模式也可以验证明确的失败结果。下面的 `errorIncludes` 必须替换成插件实际返回的脱敏错误；失败不应向 plugin data 写入错误占位：

```json
{
  "name": "invalid-base-url-is-visible",
  "runtimeId": "my-plugin/image-generator",
  "payload": { "prompt": "a harbor" },
  "expect": {
    "runtimeResults": [
      {
        "runtimeId": "my-plugin/image-generator",
        "status": "failed",
        "errorIncludes": "invalid image baseUrl"
      }
    ]
  }
}
```

### 保存图片 artifacts

如果 plugin-data value 里有 MediaRef 字段（默认 `ref`），可以导出测试图片：

```json
{
  "name": "image-live",
  "runtimeId": "my-plugin/image-generator",
  "mode": "live",
  "payload": { "prompt": "a harbor" },
  "artifacts": {
    "saveImages": {
      "namespace": "images",
      "field": "ref",
      "dir": "tests/tmp"
    }
  },
  "expect": {
    "assetGenerations": [{ "modality": "image", "field": "ref" }]
  }
}
```

---

## L5 — HTTP E2E

只在准备发布或怀疑 HTTP/SSE/session store 路径有问题时跑。需要服务端和 `.env.llm`。

```bash
pnpm e2e:verify \
  --slot e2e_local \
  --turns 3 \
  --plugins my-plugin
```

Artifacts 写到 `debugs/e2e-logs/`，包含 prompt、LLM raw response、runtime results、proposals、commit 结果。详细参数看 `docs/ship/real-model.md`。

---

## 决策树

```text
是否包含 PLUGIN.md?
└─ 是 → L1 必做

是否包含 tools/*.js / handler.js / hooks/*.js / lib provider wire?
└─ 是 → L2 至少覆盖 happy path + 一个错误路径

是否包含 agent runtime tool loop / input.inject / 多 runtime / event 链?
└─ 是 → L3 或 L4 mock 至少跑一个完整 turn/case

是否是 ~/.covel/plugins 第三方插件或需要手动 runtime 调试?
└─ 是 → L4 `pnpm test:runtime -- <plugin> --plugins-dir <path> --pretty`

是否准备发布并宣称 provider/live 能力可用?
└─ 是 → L4 live 或 L5 跑一次，人工查看 artifact/trace
```

测试失败处理：

- L1 失败：修 manifest，不要继续生成其它文件。
- L2 失败：优先修插件纯逻辑或 mock context。
- L3 失败：先看 `MockLLM.responses[]` 和 tool call `arguments` 是否是 JSON 字符串。
- L4 mock 失败：看 `runtimeResults[].error`、`pluginData._logs`、`jobs`。
- L4 live / L5 失败：先确认 `llm.toml` slot、`~/.covel/keys.env`、provider baseUrl 和网络。
