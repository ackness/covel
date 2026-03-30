# 运行时执行链流程图

时间：2026-03-30
状态：草案
关联：framework-architecture.md §9

## 核心执行链

```mermaid
flowchart TD
    A["玩家操作 / 系统事件<br/><i>KernelInput: user.input | system.event | session_start | manual_action | interval_tick | threshold_reached</i>"]
    A --> B

    B["Trigger Router<br/>识别事件类型 → 生成 RuntimeTriggerEvent<br/>按 trigger.mode (always / interval / manual / event) + onEvents 筛选候选 Runtime<br/>TurnStart Hook 在此阶段执行"]
    B --> C

    C["Runtime Scheduler<br/>按 phase 分组 (pre_story → story → post_story → background)<br/>依赖拓扑排序 → 同层并行调度<br/>应用 budget / priority / 去重 / 启用集过滤<br/>manual 触发仅在收到显式事件时进入调度"]
    C --> D

    D["Context Assembly + Locale 解析<br/>解析目标 locale: request → run → world → app default<br/>按 runtime.readScopes 裁剪最小上下文<br/>注入 10 slices: chat / world / characters / state / record /<br/>events / runtime / runtimeSettings / narrative / archive<br/>按 locale 回退规则选择 world 正文 / PLUGIN.md / prompt 资源"]
    D --> E

    E["Runtime Agent Loop<br/><i>PLUGIN.md (instructions) + Provider Binding + Tool 白名单</i><br/>插件 = Agent Skill: 文档 + 脚本 + 资源 → 构造推演上下文<br/>驱动 LLM tool calling 循环<br/>受 budget 约束 (maxSteps ⬤ / timeoutMs ⬤ / maxTokens ◐ best-effort)"]
    E --> F

    F["PreToolUse Hook / Permission Gate<br/>拦截 · 改写 · 询问 · 补充上下文 · 阻断"]
    F --> G

    G["Tool / Script / Provider 调用<br/>公开域: chat.* / state.* / event.* / record.* / provider.* / ui.* / script.*<br/>tool ID 全限定: pluginId/toolId<br/>query 直接返回 · mutate/emit 产生 proposal"]
    G --> H

    H["PostToolUse Hook / Async Hook<br/>记录结果 · 触发后台任务 · 附加验证 · 审计"]
    H --> E

    E --> I["Proposal Collection<br/>归一为 KernelProposalEnvelope<br/>typed payloads: narrative.append / state.patch / event.emit /<br/>record.upsert / ui.render / asset.generate<br/>每项携带 traceId + runtimeId + pluginId"]
    I --> J

    J["Validation / Policy<br/>Schema 校验 (typed payload) · 权限校验 · 策略校验<br/>并行冲突检测: scope 隔离优先 → 同 key 冲突默认拒绝<br/>PreStateCommit Hook · Verifier (首轮保留未执行)"]
    J --> K

    K["Commit Service<br/>写 State · 追加 Event · 更新 Record · 生成 Snapshot<br/>PostStateCommit Hook · TurnStop Hook<br/>产出 committed events"]
    K --> L

    L["Render / Side Effects / Background<br/>前端消息块 · 面板更新 · 图片 · TTS · 通知<br/>background runtime 不阻塞主响应但进入 trace"]
    L --> M

    M{"产生 follow-up events<br/>或待处理 Runtime?"}
    M -- "是 → 新事件重入 Router" --> B
    M -- "否" --> N["Turn 完成"]
```

## 并行拓扑调度示意

```mermaid
flowchart LR
    subgraph "Phase: pre_story"
        P1["memory-plugin runtime"]
    end
    subgraph "Phase: story"
        S1["主叙事 runtime"]
    end
    subgraph "Phase: post_story — 拓扑层 0"
        T0A["combat-plugin runtime"]
        T0B["inventory-plugin runtime"]
    end
    subgraph "Phase: post_story — 拓扑层 1 (依赖层 0)"
        T1A["quest-plugin runtime"]
    end
    subgraph "Phase: background"
        BG1["archive-plugin runtime"]
        BG2["embedding-index runtime"]
    end

    P1 --> S1 --> T0A & T0B --> T1A --> BG1 & BG2
```

## 插件 = Agent Skill 的结构映射

```text
plugin/
  plugin.json          ← manifest: 能力声明 + 元数据 + i18n
  PLUGIN.md            ← instructions: runtime 的推演规则文档（= agent skill prompt）
  schemas/             ← 输入输出 schema
  server/              ← runtime / tool / hook 实现
  client/              ← UI slot 扩展
  scripts/             ← 确定性脚本（dice roll、公式计算等）
  references/          ← 规则资料（RAG 源、world lore 补充）
```

插件作为 "Agent Skill" 的核心思路：

- **PLUGIN.md** 是 runtime 的核心指令文档，等价于 agent 的 system prompt + skill description
- **scripts/** 提供确定性计算能力，避免让 LLM 做数学
- **references/** 提供检索资料，在 context assembly 阶段按需注入
- **schemas/** 提供输入输出约束，让 validation 层有据可依
- runtime 通过 provider binding 调用 LLM，通过 tool 白名单控制能力面

## 全链路追踪字段

每个阶段都携带以下追踪字段，确保可观测性：

```
traceId → runId → branchId → turnId → runtimeId → pluginId
```
