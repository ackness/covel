# Web Workbench Recovery Plan

更新时间：`2026-03-27 15:57`（Asia/Shanghai）

## 目标

把当前 `apps/web` 从“单文件堆叠宿主”收敛成可维护、可操作的工作台：

- 保留现有 `HTTP + SSE + package/workflow` 运行内核。
- 参考旧项目 `_compare` 的工作台信息层级，但不迁移旧的 WebSocket/store 架构。
- 优先恢复“可用性”和“可读性”，而不是追求一次性补齐所有旧功能。

## 范围

本次只处理前端宿主层：

- `apps/web/src/App.tsx`
- `apps/web/src/styles.css`
- `apps/web/src/components/*`
- `apps/web/src/state.ts`
- `apps/web/src/types.ts`
- `apps/web/tests/app.test.tsx`

不处理：

- runtime / domain / storage / contracts 协议变更
- WebSocket、本地缓存、IndexedDB 迁回
- 多页面编辑器、项目管理器、旧插件前端内核

## 当前问题

1. `App.tsx` 同时承担数据加载、动作执行、时间线渲染、布局编排和工作台状态控制，职责失衡。
2. 左栏、中栏、右栏都在同一层直接拼接，缺少稳定的工作台骨架和信息分层。
3. 当前工作台缺少旧项目里最关键的可见控制面：会话概览、快捷动作、运行状态摘要、结构化右栏。
4. 测试覆盖了主流程，但结构上没有形成“容器 / 展示组件 / 行为 hook”的边界，后续修改成本过高。

## 关键假设

- 当前“基本无法使用”的主要原因是工作台结构混乱，而不是后端协议错误。
- 用户现在最需要的是一个稳定的单页工作台，而不是直接恢复旧项目前端的多页面编辑器。
- `core-guide`、workflow snapshot、trace、archive 已经足够支撑第一轮工作台优化。

## 方案

### 1. 保留新内核

- 继续使用 `listWorlds` / `listSessions` / `sendMessage` / `executeCommand` / `submitBlockResponse`
- 继续使用 `WorkspaceState` 和 `applySseEvent`
- 不引入旧项目的 Zustand store、WebSocket、hydration 机制

### 2. 重排工作台骨架

- `App.tsx` 降级为容器入口
- 新增专门的 workbench 组件承接三栏布局
- 左栏聚焦世界与预设入口
- 中栏聚焦会话头部、时间线、待响应 block、输入区
- 右栏保留多 tab，但把会话摘要从“重复堆叠”改成“固定概览 + 分区内容”

### 3. 借旧项目迁移最小工作台模式

从旧项目只迁移这些思想：

- 顶部明确当前会话与世界上下文
- 中栏提供一组高频操作入口
- 右栏保留角色 / 任务 / 事件 / 世界 / 扩展 / 设置 / 调试的工作台导航
- 空状态、等待状态、待交互状态要更清晰

不迁移：

- 多页面路由
- 项目编辑页
- 旧插件控制台
- 旧 transport / hydration 层

## 执行步骤

1. 写计划文档与 Mermaid，固定边界。
2. 抽离 `App.tsx` 中的数据与动作逻辑到 hook。
3. 新建 workbench 展示组件，拆出左栏和中栏。
4. 调整样式，让三栏信息密度更接近旧项目工作台。
5. 更新或补充 `apps/web` 测试，确保主链路不回退。

## 验证方式

- `pnpm test:web`
- `pnpm typecheck`
- 手工检查主流程：
  - 创建世界
  - 创建 starter world
  - 发送消息
  - slash command
  - block 响应
  - archive restore
  - 中英文切换

## 风险点

- 现有测试对文案和 DOM 结构有较多直接断言，拆分组件后需要同步更新。
- `PresetEditor` 当前自带数据加载，和页面容器的 preset 数据存在重复来源，本次只做轻量整合，不改后端协议。
- 右栏当前部分数据仍然稀疏，UI 可以更清晰，但不会凭空补出旧项目全部状态域。

## 回滚方式

- 回退本次前端改动涉及的 `apps/web` 文件和新增文档。
- 若仅 UI 结构有问题，优先保留行为 hook，回滚展示层和样式层。
