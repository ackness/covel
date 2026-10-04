# {{pluginName}}

{{pluginDescriptionZh}}

这是一个可直接改造成真实插件的多 runtime 起点：函数 runtime 负责确定性写入，agent runtime 负责阅读叙事上下文并产出结构化观察。

## 包含什么

- **`note` 函数 runtime**（`runtimes/note/`）—— 玩家点击侧栏按钮时写入一条 `notes` 记录；可替换为你的确定性副作用。
- **`analyst` agent runtime**（`runtimes/analyst/`）—— 读取当前 narrator 输出和已有 notes，判断是否需要写入一条新的观察记录。
- **包级声明**（根 `PLUGIN.md`）集中声明共享面板；公共设置、数据 schema 和命令也可放在这里。
- **侧栏 Tab UI**（`runtimes/note/ui/panel.json`）—— 展示 `notes` namespace，提供手动记录和分析当前剧情两个动作。

侧栏的“添加记录”按钮用 `invokeRuntime` 触发 manual function；`handler.js` 的 `ctx.pluginData.set` 在执行中暂存，成功后随 proposal 提交，不需要 LLM，也不会自动运行叙事 runtime。若一个操作要写入多条相互依赖的记录，在同一个 handler 中依次调用 `ctx.pluginData.set`，使它们一起提交；现成的双键写入范例见 [`plugins/tabletop-rules/runtimes/check/handler.js`](https://github.com/AcKnEsS/covel/blob/main/plugins/tabletop-rules/runtimes/check/handler.js)。`invokePluginAction` 的 RPC action 则即时写入，后续失败不回滚已成功的写入。

## 启用

将插件放到 `COVEL_USER_PLUGINS_DIR` 指定的目录后重启服务，框架会自动发现并加载。未设置时使用 `$COVEL_HOME/plugins`，再回退到 `~/.covel/plugins/`。`COVEL_PLUGINS_DIR` 用于内置插件目录。

使用默认目录时：

```bash
cp -r {{pluginName}}/ ~/.covel/plugins/
```

用户目录中的插件属于 `community` 来源：重启后会被发现并出现在插件列表里，但服务端代码（entry、handler、guard）只有在玩家进入会话并授权之后才会执行，授权不跨后端重启保留。源码开发模式（`pnpm dev`）会监听这个目录，修改 entry、handler 或 guard 后自动热重载；改动它们相对导入的依赖模块时需要重启服务。

## 测试

这个插件不需要安装依赖：handler 是普通 ES module，运行所需的上下文由框架注入。`handler.js` 里的 `PluginFunctionHandler` JSDoc 标注只描述 `ctx` 与返回值的形状，类型来自 Covel 仓库内的 `@covel/plugin-handlers-utils`。

在 Covel 仓库根目录做静态校验（只检查声明，不执行 entry）：

```bash
pnpm validate:plugin <插件目录>
```

模板自带 `tests/runtime-cases.json`，可用仓库测试包验证 manifest 加载、runtime 调用和 plugin-data 写入：

```bash
pnpm test:runtime -- {{pluginName}} --pretty
```

## 文档分工

- `README.md` 面向人类和开发者，说明插件用途、实现方式、运行时划分和维护信息。
- 根 `PLUGIN.md` 声明包身份、契约与 `contributes`；子 `RUNTIME.md` 使用 `type`、`schedule`、`io`、`agent`/`function` 分组，其正文保存 agent 提示词。
- `PLUGIN.md`、`RUNTIME.md` 和 `ui/*.json` 只写 English：名称、说明、界面文字和提示词。中文（或其他语言）的名称与说明写在 `locales/<locale>.yaml`，按清单文件分节；界面文字的译文写在同一个文件的 `messages` 里，左边是 spec 里的 English 原文，右边是译文。
- 提示词的简体中文版本是可选的 `RUNTIME.zh.md`：frontmatter 留空，正文写译文。有了它，中文会话读它而不是 English 正文，所以两份必须同步修改；没有它，所有会话都读 English 正文。

## 下一步

- 改 `runtimes/note/handler.js`，把 `notes` 记录结构替换为你的插件状态。
- 改 `runtimes/analyst/RUNTIME.md`，把“观察剧情并记录 actionable note”替换为你的实际任务。
- 改 `runtimes/note/ui/panel.json`，调整面板布局或加入更多组件（参考 `docs/reference/ui-components.md`）。
- 加新 runtime：在 `runtimes/` 下新建子目录，里面放 `RUNTIME.md`（agent 模式）或 `RUNTIME.md` + `handler.js`（function 模式）。
- 与其他插件协作：在根 `PLUGIN.md` 用 `provides` / `requires` / `optional` 声明版本化契约，runtime 通过 `io.inputs` 的 `from: { contract }` 读取；不要引用其他包的 runtime ID 或数据 namespace。
- 发布前：在根 `PLUGIN.md` 填写 `version` 和 `covel` 宿主版本范围（例如 `">=0.0.45 <0.1.0"`），安装器会拒绝范围之外的宿主。

## 参考

- [docs/guide/plugin-authoring.md](https://github.com/AcKnEsS/covel/blob/main/docs/guide/plugin-authoring.md) —— 插件作者指南
- [docs/reference/plugins.md](https://github.com/AcKnEsS/covel/blob/main/docs/reference/plugins.md) —— `PLUGIN.md` / `RUNTIME.md` 字段全表
- [docs/reference/plugin-extensions.md](https://github.com/AcKnEsS/covel/blob/main/docs/reference/plugin-extensions.md) —— 插件之间的通信方式与热重载
- [docs/reference/ui-components.md](https://github.com/AcKnEsS/covel/blob/main/docs/reference/ui-components.md) —— UI 组件目录
- [docs/guide/plugin-testing.md](https://github.com/AcKnEsS/covel/blob/main/docs/guide/plugin-testing.md) —— 插件测试
- [docs/guide/collections.md](https://github.com/AcKnEsS/covel/blob/main/docs/guide/collections.md) —— 把世界和配套插件一起发布

发布给安装器的目录必须自包含，不携带 workspace 运行时依赖；需要的 SDK helpers 在发布前打包。
