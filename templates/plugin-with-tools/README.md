# {{pluginName}}

{{pluginDescription}}

## 功能

用一到两段话说明这个插件解决什么玩家问题，以及玩家会在界面中看到什么。

## 实现

- `PLUGIN.md` 中的单 agent runtime
- `tools/example.js` 中的本地工具示例
- `PLUGIN.md` 的 Markdown 正文是运行时提示词

## 开发

1. 修改 `README.md`，维护给人类和开发者看的说明。
2. 修改 `PLUGIN.md`，维护 runtime 元信息和模型指令。
3. 用真实插件逻辑替换 `tools/example.js`。
4. 在插件目录运行 `pnpm test`。
