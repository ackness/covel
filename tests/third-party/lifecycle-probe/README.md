# Third-party Plugin Lifecycle Probe

这是一个可独立导入的第三方插件包，位于 `tests/third-party/`，不会作为内置插件随产品加载。无 npm 依赖，不需要构建；ZIP 根目录包含 `package.json`、`PLUGIN.md` 和全部运行资源。

## 打包与自动测试

在仓库根目录执行：

```sh
pnpm pack:test-plugin
pnpm test:plugin-lifecycle
pnpm --filter @covel/desktop smoke:restart
```

ZIP 输出到 `test-results/lifecycle-probe.zip`。测试将该 ZIP 通过真实安装 API 导入临时用户插件目录，然后重新 bootstrap 服务，以 `community` 来源发现和审批插件。测试使用内存存储与确定性的 LLM 响应，不调用外部模型服务。

`smoke:restart` 需要桌面图形环境，会短暂打开一个 Electron 测试窗口。它用两个本地 HTTP 服务模拟端口切换，并经过真实窗口导航保护、preload、IPC 和前端重启桥接代码；配置与浏览器数据都放在临时目录。

## 包含的能力

| 能力                                                     | 测试入口                                      |
| -------------------------------------------------------- | --------------------------------------------- |
| 同步函数 runtime、缓冲写入、失败回滚                     | `lifecycle-probe/note`                        |
| 后台函数 runtime、异步作业                               | `lifecycle-probe/background`                  |
| Agent runtime、提示词设置注入、本地工具、proposal 提交   | `lifecycle-probe/agent`                       |
| 插件服务入口、按会话记录 TurnStart hook 次数             | `server/index.js`                             |
| 独立 RPC 与逐项审批                                      | `probe-status`                                |
| 插件自有数据与 JSON Schema                               | `notes` namespace、`schemas/note.schema.json` |
| text、integer、toggle、select 设置                       | `label`、`count`、`enabled`、`voice`          |
| 多 runtime 包中的侧栏 UI、中英文标签、运行按钮与记录列表 | `runtimes/note/ui/panel.json`                 |

自动回归覆盖无凭据拒绝、安装、重复导入、重启发现、启用审批、运行审批、设置覆盖、工具执行、后台落库、RPC/hook、失败回滚、禁用与审批撤销、卸载、重启清除发现结果和重新安装。卸载保留会话数据；重新安装后仍需重新审批。

## 桌面端手动验证

1. 在测试用的 Covel 桌面实例中，进入 **设置 → 包管理**，导入 ZIP。
2. 再次导入同一个 ZIP，应提示目标已存在；旧包内容应保持不变。
3. 点击 **立即重启**。窗口应重新显示应用，`desktop.log` 应出现新端口的 `Loading` 记录。
4. 进入测试会话，在插件设置中启用 **Plugin Lifecycle Probe**，按提示批准该插件的服务端代码。
5. 在插件设置中修改 `label`、`count`；侧栏点 **写入记录**，批准该 runtime，确认列表出现记录。关闭 `enabled` 后不会新增记录。
6. 点击 **运行后台任务**，批准该 runtime，确认后台作业结束并显示记录。
7. **调用 Agent** 使用当前配置的 `plugin` 模型，会产生正常模型调用费用；自动测试中的 agent 使用模拟响应。批准 runtime 后确认本地工具写入记录。
8. 禁用插件，确认不能继续调用；重新启用后运行应重新请求审批。
9. 在包管理中卸载并重启，确认插件不再出现在目录中。再次安装并重启后，重新审批，原会话的插件记录应仍然存在。

错误回滚可用 runtime payload `{ "key": "rollback", "fail": true }` 验证：runtime 返回失败，`notes/rollback` 不应落库。`probe-status` RPC 返回当前会话的 hook 计数，方便检查禁用和撤销后的执行边界。

Windows 的 `EPERM` 回归由安装 API 测试注入该文件系统错误码；真实 Windows 安装器的完整手动流程仍需在 Windows 上执行。
