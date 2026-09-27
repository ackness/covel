# 可组合记录工作台 / Composable Notes

一个可实际安装的无模型示例：在记录面板中输入文本，原样保存，或选择独立插件处理后保存。工作台通过服务契约发现处理方式，不依赖提供者的具体 ID；三个包分别安装、启用和授权，不会自动加入内置插件列表。

| 包                    | 用途                                            | 执行形式                                      |
| --------------------- | ----------------------------------------------- | --------------------------------------------- |
| `notes-workbench`     | `/notes` 打开面板，发现处理方式、保存自己的记录 | 包级 HTML UI、命令、两个手动 function runtime |
| `note-format-clean`   | 整理行首行尾空白及多余空行，保留段落            | 仅 entry，0 runtime                           |
| `note-format-outline` | 把非空行整理成项目列表                          | 仅 entry，0 runtime                           |

## 安装与操作

在仓库根目录运行：

```sh
pnpm pack:notes-example
```

产物为 `test-results/composable-notes/` 下的三个独立 ZIP。它们不需要 npm 安装或构建，也不依赖外部网络或 LLM。

1. 在本地或桌面版的包管理中分别导入三个 ZIP，然后重启服务。
2. 打开测试会话，在插件设置中启用记录工作台和想使用的处理插件，批准对应服务端代码。授权按会话生效；服务重启后可能需要重新批准。
3. 在会话输入 `/notes`，或从插件侧栏打开记录工作台。
4. 输入文本并点击“保存记录”，默认原样保存。首次执行时批准该手动任务；取消授权会保留草稿。
5. 点击“刷新处理方式”，批准首次发现操作。从列表选择处理方式，再保存同一段文本，观察不同结果和来源。
6. 禁用选中的处理插件后，再保存会失败并保留草稿，不会偷偷改成原样保存。刷新后，该选项显示不可用；可显式选择原样保存或另一个提供者。
7. 输入 `/plugins notes-workbench` 查看服务调用关系和结果。记录正文不会进入诊断历史。

支持中英文与窄屏。界面使用独立 HTML webview，经宿主桥调用自己的 runtime；它不能直接请求服务提供者，也不能读取其他插件的私有数据。保存成功才清空草稿，已保存记录通过本插件的 `notes` 数据源更新。

## 组合边界

- 工作台有两个手动任务：`notes-workbench/providers` 和 `notes-workbench/save`。操作不产生玩家回合，也不运行叙事或模型。
- 服务名为 `format-note`，契约为 `examples/note-format@1`，输入 `{ text }`，输出 `{ text }`。输入最多 4000 个 UTF-16 单元、输出最多 8000 个，均须包含非空白内容。结果是纯文本，UI 使用 `textContent` 显示。
- 提供者只计算结果。工作台检查服务结果后，写入自己的 `notes` namespace，保存 `id`、`originalText`、`text`、`providerPluginId` 和 `createdAt`。原样保存的提供者为 `null`。
- 每次保存重新发现匹配服务，再按选中的提供者调用，服务调用预算为 1500 ms。未启用、未授权、超时或输出校验失败均不会创建记录；不自动重试保存或替换提供者。
- 新增提供者只需注册相同服务名和契约，安装并启用后刷新即可出现。`description` 用于选择列表展示；不需要修改工作台代码。
- 示例没有长连接、计时器或共享缓存，因此没有为了展示而增加 `onDispose`。真实资源清理示例仍在 `tests/third-party/lifecycle-probe`。

## 验证与独立调试

```sh
# Pure computation tests and real ZIP installation/approval/API integration.
pnpm test:notes-example

# Root and child manifest arguments both validate the complete owning package.
pnpm validate:plugin examples/composable-notes/plugins/notes-workbench

# Save through a provider in the isolated multi-plugin harness.
pnpm test:runtime -- notes-workbench/save \
  --plugins-dir examples/composable-notes/plugins \
  --with-plugin note-format-clean \
  --payload '{"text":"  First line  \n\n\nSecond line  ","providerPluginId":"note-format-clean"}' \
  --pretty
```

把提供者同时改为 `note-format-outline` 可验证切换。CLI 只执行选定的本地包，没有生产审批弹窗；HTTP 集成测试通过真实 ZIP 安装、重启发现及会话审批验证权限边界。

原有内置业务插件和生命周期测试探针保持独立。这个示例展示组合方式，不提供多人同步、后台队列、富文本编辑或模型生成。
