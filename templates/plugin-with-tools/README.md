# {{pluginName}}

{{pluginDescription}}

## 功能

用一到两段话说明这个插件解决什么玩家问题，以及玩家会在界面中看到什么。

## 实现

- `PLUGIN.md` 中的单 agent runtime
- `tools/record-note.js` 中的本地工具示例
- `PLUGIN.md` 的 Markdown 正文是运行时提示词

## 开发

1. 修改 `README.md`，维护给人类和开发者看的说明。
2. 修改 `PLUGIN.md`，维护 runtime 元信息和模型指令。
3. 用真实插件逻辑替换 `tools/record-note.js`。
4. 在 Covel 仓库根目录运行 `pnpm install`，让模板的 `workspace:*` 依赖从根 workspace 解析。
5. 在 Covel 仓库根目录运行 `pnpm --filter @covel/plugin-{{pluginName}} lint` 和 `pnpm --filter @covel/plugin-{{pluginName}} test`。`checkJs` 通过公开 SDK 的 `PluginAPI` / `PluginToolkit` 检查入口和工具实现。
6. 用 `pnpm validate:plugin plugins/{{pluginName}}` 做静态校验（只检查声明，不执行 entry）。`entry` 中的注册必须与 `contributes` 双向一致：未声明的注册和未实现的声明都会让插件加载失败。
7. 用 `pnpm test:runtime -- {{pluginName}} --plugins-dir <plugins-dir> --pretty` 跑 `tests/runtime-cases.json`，验证 manifest、工具调用和 plugin-data 写入。
8. 作为内置插件提交前运行 `pnpm check`（含 manifest、i18n 与 README 检查），并在 `docs/reference/plugins.md` 同步说明。

## 参考

- [docs/guide/plugin-authoring.md](../../docs/guide/plugin-authoring.md) —— 插件作者指南
- [docs/reference/plugins.md](../../docs/reference/plugins.md) —— `PLUGIN.md` / `RUNTIME.md` 字段全表
- [docs/reference/tools.md](../../docs/reference/tools.md) —— 工具契约与审批策略
- [docs/guide/plugin-testing.md](../../docs/guide/plugin-testing.md) —— 插件测试
