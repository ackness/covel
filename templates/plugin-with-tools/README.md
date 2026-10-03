# {{pluginName}}

{{pluginDescriptionZh}}

## 功能

用一到两段话说明这个插件解决什么玩家问题，以及玩家会在界面中看到什么。

## 实现

- `PLUGIN.md` 中的单 agent runtime
- `tools/record-note.js` 中的本地工具示例
- `PLUGIN.md` 的 Markdown 正文是运行时提示词，用 English 写
- `locales/zh.yaml` 是名称与说明的中文译文

## 开发

1. 修改 `README.md`，维护给人类和开发者看的说明。
2. 修改 `PLUGIN.md`，维护 runtime 元信息和模型指令。
3. 用真实插件逻辑替换 `tools/record-note.js`。
4. 提示词定稿后新增 `PLUGIN.zh.md`（frontmatter 留空，正文写简体中文译文）。内置插件必须同时提供两种语言；之后在仓库根目录运行 `pnpm prompts:lock` 记录这一对，`pnpm check:prompts` 会在两份不同步时报错。
5. 在 Covel 仓库根目录运行 `pnpm install`，让模板的 `workspace:*` 依赖从根 workspace 解析。
6. 在 Covel 仓库根目录运行 `pnpm --filter covel-plugin-{{pluginName}} lint` 和 `pnpm --filter covel-plugin-{{pluginName}} test`。`checkJs` 通过公开 SDK 的 `PluginAPI` / `PluginToolkit` 检查入口和工具实现。
7. 用 `pnpm test:runtime -- {{pluginName}} --plugins-dir <plugins-dir> --pretty` 跑 `tests/runtime-cases.json`，验证 manifest、工具调用和 plugin-data 写入。
