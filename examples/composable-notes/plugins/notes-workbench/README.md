# Notes Workbench

可安装的记录工作台，使用 `/notes` 打开包级 HTML 面板。原样保存不需要其他插件；“刷新处理方式”会发现已启用且已批准的 `examples/note-format@1` 服务。

工作台拥有自己的 `notes` 数据。服务提供者只返回文本，工作台在成功后统一提交记录；失败或取消授权保留草稿，不创建记录。两个手动任务都不调用 LLM、不推进玩家回合。

安装步骤、服务契约、测试与多插件调试见 [组合示例说明](../../README.md)。ZIP 独立安装后请参考仓库 `examples/composable-notes/README.md`。
