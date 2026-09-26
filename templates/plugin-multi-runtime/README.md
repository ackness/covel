# {{pluginName}}

{{pluginDescription}}

这是一个可直接改造成真实插件的多 runtime 起点：函数 runtime 负责确定性写入，agent runtime 负责阅读叙事上下文并产出结构化观察。

## 包含什么

- **`note` 函数 runtime**（`runtimes/note/`）—— 玩家点击侧栏按钮时写入一条 `notes` 记录；可替换为你的确定性副作用。
- **`analyst` agent runtime**（`runtimes/analyst/`）—— 读取当前 narrator 输出和已有 notes，判断是否需要写入一条新的观察记录。
- **侧栏 Tab UI**（`runtimes/note/ui/panel.json`）—— 展示 `notes` namespace，提供手动记录和分析当前剧情两个动作。

侧栏的“添加记录”按钮用 `invokeRuntime` 触发 manual function；`handler.js` 的 `ctx.pluginData.set` 在执行中暂存，成功后随 proposal 提交，不需要 LLM，也不会自动运行叙事 runtime。若一个操作要写入多条相互依赖的记录，在同一个 handler 中依次调用 `ctx.pluginData.set`，使它们一起提交；现成的双键写入范例见 [`plugins/tabletop-rules/runtimes/check/handler.js`](../../plugins/tabletop-rules/runtimes/check/handler.js)。`invokePluginAction` 的 RPC action 则即时写入，后续失败不回滚已成功的写入。

## 启用

将插件放到 `COVEL_USER_PLUGINS_DIR` 指定的目录后重启服务，框架会自动发现并加载。未设置时使用 `$COVEL_HOME/plugins`，再回退到 `~/.covel/plugins/`。`COVEL_PLUGINS_DIR` 用于内置插件目录。

使用默认目录时：

```bash
cp -r {{pluginName}}/ ~/.covel/plugins/
pnpm install --dir ~/.covel/plugins/{{pluginName}}   # 如果有依赖
```

## 测试

模板自带 `tests/runtime-cases.json`，可用仓库测试包验证 manifest 加载、runtime 调用和 plugin-data 写入：

```bash
pnpm test:runtime -- {{pluginName}} --pretty
```

## 文档分工

- `README.md` 面向人类和开发者，说明插件用途、实现方式、运行时划分和维护信息。
- `PLUGIN.md` 面向框架和模型，保存展示元信息、触发条件、工具声明和 agent runtime 的提示词。

## 下一步

- 改 `runtimes/note/handler.js`，把 `notes` 记录结构替换为你的插件状态。
- 改 `runtimes/analyst/PLUGIN.md`，把“观察剧情并记录 actionable note”替换为你的实际任务。
- 改 `runtimes/note/ui/panel.json`，调整面板布局或加入更多组件（参考 `docs/reference/ui-components.md`）。
- 加新 runtime：在 `runtimes/` 下新建子目录，里面放 `PLUGIN.md`（agent 模式）或 `PLUGIN.md` + `handler.js`（function 模式）。

## 参考

- [docs/guide/plugin-authoring.md](https://github.com/AcKnEsS/covel/blob/main/docs/guide/plugin-authoring.md) —— 插件作者指南
- [docs/reference/plugins.md](https://github.com/AcKnEsS/covel/blob/main/docs/reference/plugins.md) —— frontmatter 字段全表
- [docs/reference/ui-components.md](https://github.com/AcKnEsS/covel/blob/main/docs/reference/ui-components.md) —— UI 组件目录
