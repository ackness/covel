# Covel 插件开发指南

先选择扩展入口，再写插件包。需要生成文字时使用 agent runtime；确定性的计算、导入或外部 API 调用使用 function runtime；提示词片段、历史变换、压缩和世界上下文使用公开扩展点。

本指南对应当前作者格式。根文件为 `PLUGIN.md`，多 runtime 子文件为 `RUNTIME.md`。旧平铺字段、子目录 `PLUGIN.md`、`relations` 和框架记忆专用字段均不再接受；旧开发会话和 checkpoint 应重建。

## 三条路径

| 需求                             | 指南                                          |
| -------------------------------- | --------------------------------------------- |
| 只写 YAML 和提示词               | [零代码插件](plugin-authoring-zero-code.md)   |
| agent 配合本地工具或 RPC         | [Agent 与本地代码](plugin-authoring-agent.md) |
| 多 runtime、数据契约、权限和发布 | [高级作者指南](plugin-authoring-advanced.md)  |

完整字段和内置示例见[插件契约参考](../reference/plugins.md)，公开扩展点见[插件扩展点](../reference/plugin-extensions.md)。

## 最小闭环

```sh
pnpm create-plugin
pnpm validate:plugin plugins/my-plugin
pnpm --filter @covel/plugin-my-plugin test
```

按生成器提示选择模板。包至少包含 `package.json`、`PLUGIN.md`，并为维护者提供 `README.md`。根清单的 `id` 必须与目录一致，单 runtime 使用根 `runtime`，多 runtime 使用 `runtimes/<id>/RUNTIME.md`，不要同时声明两种布局。

```yaml
---
id: my-plugin
kind: plugin
description: Adds a brief observation after narration.
runtime:
  type: agent
  schedule:
    stage: post-turn
  io:
    inputs:
      narrative:
        from: { contract: narrative-engine@1 }
        select: /narrativeOutput
        required: true
    visibility: plugin
  agent:
    model: plugin
---
Write one observation grounded in runtime-inputs.narrative.value.
```

通过校验后从插件管理界面安装并启用。社区插件的服务端代码需要授权，作者清单本身不会授予权限。安装位置和包管理流程见[插件安装](../reference/plugin-installation.md)。

## 声明与实现对齐

所有包级贡献写在根 `contributes`。entry 模块注册工具、RPC action、服务、扩展、hook、wire 或 form 时，名称必须与清单一致。`contributes.commands` 是玩家命令元数据，实际 RPC 名还必须列在 `contributes.actions`。

只在运行时需要的工具放进 `agent.tools`。这份白名单控制 agent 能调用什么；`contributes.tools` 声明包实际注册什么。两者用途不同。

跨插件调用使用版本化契约，例如 `narrative-engine@1`。根 `requires` 驱动会话依赖解析，`io.inputs` 绑定执行结果，`schedule.needs` 控制运行条件。普通契约可以有多个提供者；用 `cardinality: one/all` 指定输入要求，用显式 `conflicts` 或单提供者扩展点表达互斥。

**跨包依赖边界**：`needs`、`after` 和 `io.inputs` 的跨包引用必须使用版本化契约（如 `narrative-engine@1`），不允许直接引用其他插件的 runtime 名称（如 `other-plugin/some-runtime`）。包内多个 runtime 之间可以使用 runtime 名称建立排序和输入关系，但跨包必须通过公开契约解耦。违反此规则的 manifest 加载时会被拒绝。

## 数据归属

角色和角色 schema 读取 `ctx.world`，角色写入通过 proposals。不要把角色复制到本插件的 `characters` namespace，也不要扫描其他插件私有 schema。

插件私有数据使用绑定 store：`getPluginData(namespace, key)`、`listPluginData(namespace?)`。不同插件共享数据必须声明公开契约。可导入世界数据的 namespace 在 `contributes.data` 声明 `version/schema/accepts`，其契约 schema 放在根 `contracts`。见 [World Data](../reference/world-data.md)。

记忆语义由 memory 插件和其 `memory.block-definitions@1` 服务拥有。世界自定义记忆块通过 `memory.blocks@1` 导入。不要新增 `memoryBlocks` 或 `summaryFocus` 根字段。

## 提示词与本地化

Agent 正文放在相应 `PLUGIN.md` 或 `RUNTIME.md`。静态附加段用根 `contributes.prompt`，动态内容用 `prompt.segment@1`。同包静态段不按 runtime 筛选，多 runtime 的局部规则应写在各自正文中。

翻译文件分别为 `PLUGIN.en.md`、`RUNTIME.en.md` 等。只翻译正文与自然语言字段，未出现的字段继承 canonical。工具、依赖、契约、提示词段 ID 和位置不能由翻译覆盖。运行时生成的消息使用 `ctx.locale` 选择文案；不要只翻译清单而遗漏工具返回值。

## 验证与发现

- `pnpm validate:plugin <目录 | PLUGIN.md | RUNTIME.md>` 验证整个包，包括其他子 runtime。
- `GET /api/plugins/:id` 返回包的契约、设置、runtime、工具、UI 和数据声明。
- `GET /api/framework/capabilities` 返回框架原语和发现入口。
- `GET /api/worlds/:id/plugin-plan` 返回世界策略和显式默认请求。

测试应验证用户可观察的结果、非法输入、数据归属，以及失败时不发生部分提交。CI 前运行项目的 `pnpm lint` 和 `pnpm test`；涉及玩家 UI 流程时补相应浏览器验收。
