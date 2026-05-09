# {{pluginName}}

Hello-world 示范插件 —— 演示 Covel 第三方插件的最小可用骨架。

## 包含什么

- **`echo` 函数 runtime**（`runtimes/echo/`）—— 玩家点击侧栏按钮，handler 直接往 `messages` namespace 追加一条 "hello"。
- **`summarizer` agent runtime**（`runtimes/summarizer/`）—— 玩家点击侧栏第二个按钮，agent 拿到 narrator 当前输出，用 100 字内总结，调用 `plugin-data-set` 写回同一个 namespace。
- **侧栏 Tab UI**（`runtimes/echo/ui/panel.json`）—— 一个 `Hello World` 标签页，含两个按钮 + 消息列表，自动订阅 `messages` namespace 的 SSE 变更。

## 启用

复制本目录到 `COVEL_PLUGINS_DIR`（默认 `~/.covel/plugins/`）后重启服务，框架会自动发现并加载。

```bash
cp -r {{pluginName}}/ ~/.covel/plugins/
pnpm install --dir ~/.covel/plugins/{{pluginName}}   # 如果有依赖
```

## 文档分工

- `README.md` 面向人类和开发者，说明插件用途、实现方式、运行时划分和维护信息。
- `PLUGIN.md` 面向框架和模型，保存展示元信息、触发条件、工具声明和 agent runtime 的提示词。

## 下一步

- 改 `runtimes/echo/handler.js`，把 "hello" 换成你想要的副作用。
- 改 `runtimes/summarizer/PLUGIN.md`，把 system prompt 换成你的 agent 任务。
- 改 `runtimes/echo/ui/panel.json`，调整面板布局或加入更多组件（参考 `docs/reference/ui-components.md`）。
- 加新 runtime：在 `runtimes/` 下新建子目录，里面放 `PLUGIN.md`（agent 模式）或 `PLUGIN.md` + `handler.js`（function 模式）。

## 参考

- [docs/guide/plugin-authoring.md](https://github.com/your-org/covel/blob/main/docs/guide/plugin-authoring.md) —— 插件作者指南
- [docs/reference/plugins.md](https://github.com/your-org/covel/blob/main/docs/reference/plugins.md) —— frontmatter 字段全表
- [docs/reference/ui-components.md](https://github.com/your-org/covel/blob/main/docs/reference/ui-components.md) —— UI 组件目录
