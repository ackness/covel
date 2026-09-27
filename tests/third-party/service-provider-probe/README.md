# Service Provider Probe

这是仅含 `entry` 的第三方测试包，没有 runtime 或 UI。`server/index.js` 注册纯函数服务 `format-note`，契约为 `probe/note-format@1`，以 Zod 校验输入和输出。提供者不读取或写入会话数据；调用方负责提交自己的结果。

`lifecycle-probe` 的 `note` 手动 function runtime 通过 payload 的 `providerPluginId` 选择它。完整安装、审批、启停和调用回归见 `apps/server/tests/api/third-party-plugin-lifecycle.test.ts`；在仓库根目录运行：

```sh
pnpm --filter @covel/server exec vitest run tests/api/third-party-plugin-lifecycle.test.ts
```
