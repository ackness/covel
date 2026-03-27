# Web Workbench Frontend Declutter Plan

更新时间：`2026-03-27 17:18`（Asia/Shanghai）

## 目标

在保留三栏工作台的前提下，把当前 `apps/web` 从“重复堆叠状态块”收敛成清晰的操作界面：

- 左栏只负责导航、创建入口和 preset 管理。
- 中栏只负责当前世界上下文、会话主轴、待交互 block 和输入。
- 右栏只负责当前会话概览、世界上下文和运行诊断。

## 范围

本次只改前端宿主层与对应测试：

- `apps/web/src/App.tsx`
- `apps/web/src/components/session-workbench.tsx`
- `apps/web/src/components/workbench-left-rail.tsx`
- `apps/web/src/components/workbench-side-panel.tsx`
- `apps/web/src/styles.css`
- `apps/web/tests/app.test.tsx`

不改：

- runtime / SSE 协议
- storage / domain / model gateway
- preset 持久化逻辑

## 视觉与交互假设

- visual thesis：界面应更像一张安静的编辑工作台，而不是三列并排的卡片墙。
- content plan：左侧选世界与创建，中间执行会话，右侧查看上下文与诊断。
- interaction thesis：弱化边框与重复 badge；把当前焦点集中在中栏头部；右栏 tab 改成更轻的上下文切换。

## 当前问题

1. 世界、会话、preset、运行状态在左栏、中栏、右栏多次重复出现。
2. 右栏顶部摘要和中栏 Hero 都在表达“当前会话是谁、状态是什么”，信息竞争严重。
3. 左栏把“世界列表”“创建世界”“preset 编辑”直接堆在一起，缺少层级。
4. 页面存在过多卡片边框、徽标和局部高亮，导致真正高频操作不突出。

## 关键假设

- 当前主要问题是信息架构，而不是数据不足。
- 需要减少重复，而不是继续新增区块。
- 保持现有三栏结构比改成新布局更稳妥，符合仓库既有方向。

## 执行步骤

1. 先用测试固定新的主界面层级和关键文案。
2. 重构左栏，使其区分“世界导航”和“创建入口”。
3. 重构中栏头部，把世界概览、会话操作和状态摘要收成一个清晰区域。
4. 精简右栏固定摘要，只保留高价值概览；其余信息放入 tab 内容。
5. 统一样式，减少厚重卡片感，补移动端收缩规则。

## 验证方式

- `pnpm test:web`
- `pnpm typecheck`
- 手工检查：
  - 创建世界
  - 创建 starter world
  - 创建会话
  - 发送消息
  - 切换右栏 tab
  - 中英文切换

## 风险点

- 现有测试对 DOM 结构和中文文案有断言，改动后需要同步更新。
- `PresetEditor` 仍然是独立块，本次只做布局收敛，不重写其数据来源。
- 右栏调试信息依旧较多，但会收进更明确的结构里，不一次性删功能。

## 回滚方式

- 回退本次涉及的 `apps/web` 文件和本计划文档。
- 若仅视觉方向不合适，保留结构重构，回滚样式层即可。
