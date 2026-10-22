# {{pluginName}}

{{pluginDescriptionZh}}

## 功能

用一到两段话说明这个插件解决什么玩家问题，以及玩家会在界面中看到什么。

## 实现

- `PLUGIN.md` 中的单 agent runtime
- `tools/record-note.js` 中的本地工具示例
- `PLUGIN.md` 的 Markdown 正文是运行时提示词，用 English 写
- `locales/zh.yaml` 是名称与说明的中文译文

版本从 `0.1.0` 开始，只写在 `PLUGIN.md`；`package.json` 只让这个包成为 workspace 成员，不写版本。发布新版本时改 `PLUGIN.md` 的 `version`，再做静态校验。插件 ID 就是目录名，`server/index.js` 是默认的 `entry`，两者都不用写。

`tests/runtime-cases.json` 带编辑器用的 `$schema`。用例必须写 `name` 和 `runtimeId`；未知字段（包括拼错的 `expect`）会在执行前报错。

## 开发

开发依赖使用 TypeScript 7.0.2 和 Zod 4.6.7 或更高的兼容版本。保持 Zod 与宿主 SDK 的最低版本一致，避免 TypeScript 7.1 的递归 JSON 类型错误；运行时仍由宿主提供 SDK 和 Zod。

1. 修改 `README.md`，维护给人类和开发者看的说明。
2. 修改 `PLUGIN.md`，维护 runtime 元信息和模型指令。
3. 用真实插件逻辑替换 `tools/record-note.js`。
4. 提示词定稿后新增 `PLUGIN.zh.md`（frontmatter 留空，正文写简体中文译文）。内置插件必须同时提供两种语言；之后在仓库根目录运行 `pnpm prompts:lock` 记录这一对，`pnpm check:prompts` 会在两份不同步时报错。
5. 在 Covel 仓库根目录运行 `pnpm install`，让模板的 `workspace:*` 依赖从根 workspace 解析。
6. 在 Covel 仓库根目录运行 `pnpm --filter @covel/plugin-{{pluginName}} lint` 和 `pnpm --filter @covel/plugin-{{pluginName}} test`。`checkJs` 通过公开 SDK 的 `PluginAPI` / `PluginToolkit` 检查入口和工具实现。
7. 用 `pnpm validate:plugin plugins/{{pluginName}}` 做静态校验（只检查声明，不执行 entry）。`entry` 中的注册必须与 `contributes` 双向一致：未声明的注册和未实现的声明都会让插件加载失败。
8. 用 `pnpm test:runtime -- {{pluginName}} --plugins-dir <plugins-dir> --pretty` 跑 `tests/runtime-cases.json`，验证 manifest、工具调用和 plugin-data 写入。
9. 作为内置插件提交前运行 `pnpm check`（含 manifest、i18n 与 README 检查），并在 `docs/reference/plugins.md` 同步说明。

## 参考

- [docs/plugins/essentials.md](../../docs/plugins/essentials.md) —— 插件作者指南
- [docs/reference/plugins.md](../../docs/reference/plugins.md) —— `PLUGIN.md` / `RUNTIME.md` 字段全表
- [docs/reference/tools.md](../../docs/reference/tools.md) —— 工具契约与审批策略
- [docs/plugins/testing.md](../../docs/plugins/testing.md) —— 插件测试
