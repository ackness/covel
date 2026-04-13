---
name: aimock-test-playbook
description: 为以 AI 能力为核心的仓库设计分层测试方案，适合调研或接入 CopilotKit/aimock、把真实模型调用改为录制回放、拆分 fake/unit 与 replay/live 测试、优化缓慢的 Playwright 或 provider 集成测试，并为使用 LLM、SDK 或 provider API 的 Node.js/TypeScript 项目形成可执行的适配计划与命令。当用户提到 aimock、record/replay、LLM mock、慢测试、真实模型回放、重型 e2e、保留关键测试、测试分层、provider 边界验证时触发。
---

# Aimock Test Playbook

先确定测试分层，再判断 `aimock` 应放在哪一层。不要默认把所有测试都改成回放；大多数业务逻辑测试仍然更适合保留为进程内 fake。

## 先做判断

先回答这 3 个问题：

1. 这条测试到底在验证什么？
   - 调度、状态机、prompt 拼装、插件触发、数据持久化：优先考虑 fake adapter 或 fake LLM。
   - provider HTTP 序列化、流式解析、fallback、真实响应格式：优先考虑 `aimock` 回放测试。
   - 供应商漂移、密钥与环境、端到端真实链路：保留少量显式开启的 live test。

2. 被测代码有没有明确的 HTTP provider 边界？
   - 如果系统只是注入 `LLMAdapter` 或等价接口，`aimock` 往往不是最合适的选择。
   - 如果可以通过 `baseUrl` 或 SDK client 配置切换到本地 mock server，`aimock` 的接入成本通常较低。

3. 默认 CI 真的需要这条测试吗？
   - 默认路径只保留快且稳定的测试。
   - 录制回放测试放在第二层。
   - 真模型测试改为 nightly、手动触发，或通过显式环境变量开启。

## 工作流

### 1. 盘点现状

先确认：

- 哪些测试已经在用 fake LLM / fake adapter
- 哪些测试会直接打 provider HTTP
- 哪些 Playwright/E2E 实际依赖真实模型
- 哪些脚本只是人工 smoke，不应该混进默认 CI

优先从以下边界入手：

- provider client / SDK 初始化
- `baseUrl`、`apiKey`、transport、headers 注入点
- 应用层抽象，比如 `LLMAdapter`、gateway、client factory
- live test、Playwright、手工 smoke script 所在目录

### 2. 选测试层

默认采用以下规则：

- `fake/unit`：覆盖大多数业务逻辑、编排、状态、路由和工具执行。
- `aimock/replay`：覆盖 provider 边界、流式协议，以及基于 fixture 的 UI/API smoke。
- `live/opt-in`：只保留少量关键冒烟，用于验证供应商漂移与环境配置。

如果要验证的只是“系统收到一段输出后如何处理”，通常不必引入 `aimock`，直接使用 fake 即可。

### 3. 设计适配方案

给出一份明确的迁移表，而不是笼统建议。至少包含：

- 保留为 fake 的测试文件/目录
- 迁移到 `aimock` replay 的测试文件/目录
- 降级为 live smoke 的测试文件/目录
- 建议新增的 recorded fixture 目录
- 需要的环境变量、启动命令、CI 切分方式

### 4. 输出可执行建议

默认输出以下四部分：

1. 当前慢测试来源
2. `aimock` 是否适配以及为什么
3. 推荐的测试分层矩阵
4. 最小改造路径

只有在用户明确要求落地实现时，才继续编写代码或调整配置。

## 默认交付物

把它视为一个“先调研、再分层、最后决定是否改造”的通用工作手册。

默认先交付：

1. 测试资产盘点
2. fake / replay / live 分层表
3. `aimock` 适配可行性判断
4. 最小落地路径

只有在用户明确要求实现时，才进入代码或配置修改阶段。

## 何时读取参考资料

- 需要 `aimock` 能力、record/replay、CLI、Vitest/Jest 插件信息时：读 `references/aimock-capabilities.md`
- 需要可直接改写进用户项目的官方用法示例时：读 `references/official-examples.md`
- 需要给任意仓库做适配盘点时：读 `references/repo-adaptation-checklist.md`
- 需要把测试拆成 fake / replay / live 的决策矩阵时：读 `references/test-layering.md`
- 只有仓库就是 COVEL，或用户明确要 COVEL 案例时：读 `references/case-study-covel.md`

## 输出标准

输出尽量明确到：

- 文件路径
- 环境变量名
- fixture 目录建议
- 哪些测试应从默认 CI 移出
- 哪些测试应该被新建成更快的关键集成测试

不要只给出“可以使用 aimock”这一类泛化结论。需要说明在当前仓库中，它适合替代哪些测试，不适合替代哪些测试。
