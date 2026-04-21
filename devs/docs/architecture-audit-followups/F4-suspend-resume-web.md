# F4 · Web 端 suspend/resume 能力闭环

**Status**: pending · **Est**: 6–8 hours · **Risk**: low (纯前端 + 后端已完备) · **Depends on**: 无

---

## 1. 背景:为什么需要这个

### 1.1 Suspend/Resume 是什么

Covel 的 runtime 执行模型默认是"一次回合跑到底"——玩家输入 → 所有 runtime 并行执行 → 产出叙事 → 结束回合。

但有些插件**无法在单个 turn 内完成**,典型场景:

- **图像生成**:插件调用 fal.ai 产出任务 ID,需要等 30 秒 ~ 5 分钟才能 poll 到结果。阻塞整个回合不合理。
- **人工审核**:NPC 关键决策需要玩家确认后再继续。
- **外部系统回调**:比如接了一个外部"裁判系统",玩家的战斗结果靠 webhook 返回。

为此 Covel 设计了 **suspend/resume** 机制:
1. Runtime 执行时发现需要等待 → 调 suspend 工具 / 返回 `status: 'suspended'`。
2. 框架把 runtime 标为 suspended,**回合正常收尾**(不阻塞叙事)。
3. 外部系统准备好数据后,调 `POST /api/sessions/:id/resume` 带 resume data。
4. 框架把 runtime 从暂停状态唤醒,**继续上次的 LLM tool loop**,产出叙事后正式收尾。

### 1.2 后端完全闭环

**证据 A** · 协议层定义齐全 · [`packages/shared/src/types/protocol.ts:114-116`](../../../packages/shared/src/types/protocol.ts)

```ts
// ProtocolEventType 包含:
'turn.suspended'
'turn.resumed'
```

**证据 B** · Runtime 两条路径都会发 suspend 事件 · [`packages/runtime/src/turn-executor.ts:~1540, ~2140`](../../../packages/runtime/src/turn-executor.ts)

- Function runtime 路径:runtime 返回 `{ status: 'suspended', suspensionData }` → executor 发 `turn.suspended` SSE。
- Agent runtime 路径:LLM 调用 `suspend` 工具 → executor 把 tool call ID 保存到 pending continuation 表 → 发 `turn.suspended`。

**证据 C** · Resume 接口完备 · [`apps/server/src/routes/api/resume.ts`](../../../apps/server/src/routes/api/resume.ts)

```
POST   /api/sessions/:id/resume                         — 传 resume data 唤醒 runtime
GET    /api/sessions/:id/suspensions                    — 列出未解决的挂起
DELETE /api/sessions/:id/suspensions/:suspensionId      — 丢弃一个挂起(取消)
```

**证据 D** · 持久化层完整 · `DataStore.listSuspensions / getSuspension / deleteSuspension` 都实现了,跨 Memory / SQLite / PG 后端契约测试覆盖。

### 1.3 前端完全不消费

**证据 E** · [`apps/web/src/stores/session-store.tsx:939-949`](../../../apps/web/src/stores/session-store.tsx)

```ts
case "runtime.completed": {
  // ...
  return {
    ...state,
    executionSteps: state.executionSteps.map((s) =>
      s.runtimeId === runtimeId ? { ...s, status: "completed" } : s
      //                                    ^^^^^^^^^^^^^^^^^^
      //          硬编码 completed,从不看 payload.status
    ),
  };
}
```

即使后端 runtime 以 `status: 'suspended'` 回报,前端也会画成"已完成"。

**证据 F** · 搜索前端代码 `rg "turn\\.suspended|turn\\.resumed" apps/web/src` 命中 0 —— 这两个 SSE 事件类型在前端根本不存在处理分支。

**证据 G** · UI 层搜 `suspension` 关键字命中 0 —— 没有挂起列表、没有 resume 按钮、没有任何可视化入口。

### 1.4 实际的用户体验

假设玩家使用了一个声明了图像生成的世界包,当前链路:

1. 玩家输入"看看那把剑"
2. 叙事插件返回描述性文字
3. 图像生成插件 suspend 等 fal.ai
4. **前端 runtime 显示"已完成"(谎言)**
5. 玩家以为一切结束,继续下一回合动作
6. 3 分钟后后端 `turn.resumed` 塞回来,前端**不认识这个事件**,静默丢弃
7. 底层 DB 已经有了图片,但前端永远不渲染
8. 玩家以为插件坏了

也就是说:**Covel 花了好几个 sprint 设计的完整 suspend/resume 后端能力,在 Web 上等于不存在**。

---

## 2. 目标

1. 前端**诚实报告** runtime 的 `suspended` 状态,不再骗玩家说"已完成"。
2. 前端**主动响应** `turn.suspended` / `turn.resumed` SSE 事件,维持 suspensions 队列。
3. 前端**给玩家操作入口**:查看挂起的 runtime、手动 resume、取消。
4. 刷新 / 切换会话时能**同步状态**,通过 `GET /api/sessions/:id/suspensions` 对齐。

---

## 3. 实施方案

### 3.1 阶段 1 · 前端状态模型扩展(~3h)

#### 3.1.1 Session state 加 suspensions 字段

在 [`apps/web/src/stores/session-store.tsx`](../../../apps/web/src/stores/session-store.tsx) 里:

```ts
// 新增类型(从 @covel/shared import 或就地定义)
interface SuspensionRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly suspendedAt: string;  // ISO
  readonly reason?: string;
  readonly expectedResumeSchema?: Record<string, unknown>;  // 可选的 JSON schema
  readonly metadata?: Record<string, unknown>;              // 插件自定义
}

interface SessionState {
  // ...existing fields
  suspensions: SuspensionRecord[];  // 活跃挂起列表
}
```

reducer 新增三个 case:

```ts
case "runtime.completed": {
  const status = (action.event.payload.status as RuntimeStatus) || "completed";
  //              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  //              读真实 status,不再硬编码
  return {
    ...state,
    executionSteps: state.executionSteps.map(s =>
      s.runtimeId === runtimeId ? { ...s, status } : s
    ),
  };
}

case "turn.suspended": {
  const suspension = action.event.payload as SuspensionRecord;
  return {
    ...state,
    suspensions: [...state.suspensions, suspension],
  };
}

case "turn.resumed": {
  const { suspensionId } = action.event.payload as { suspensionId: string };
  return {
    ...state,
    suspensions: state.suspensions.filter(s => s.id !== suspensionId),
  };
}
```

#### 3.1.2 进会话时拉一次 suspensions

在 session-store 的 `boot()` / 切换 session 的逻辑里:

```ts
// 拉初始 suspensions 列表,避免刷新后丢失视图
const suspensions = await api.listSuspensions(sessionId);
dispatch({ type: "SET_SUSPENSIONS", suspensions });
```

需要在 [`apps/web/src/services/api.ts`](../../../apps/web/src/services/api.ts) 加一个 `listSuspensions(sessionId)` 封装函数,HTTP 打 `GET /api/sessions/:id/suspensions`。

#### 3.1.3 `ExecutionStep.status` 加 `suspended` 变体

当前 `ExecutionStep.status` 可能是 `running | completed | failed` 三种。加 `suspended`:

```ts
export type ExecutionStepStatus = 'running' | 'completed' | 'failed' | 'suspended';
```

### 3.2 阶段 2 · UI 入口(~3h)

#### 3.2.1 Badge 入口(game-view)

[`apps/web/src/components/session/game-view.tsx`](../../../apps/web/src/components/session/game-view.tsx) 顶栏在"debug"按钮旁边加 suspensions badge:

```tsx
{state.suspensions.length > 0 && (
  <Button onClick={() => setSuspensionsOpen(true)} variant="outline" size="sm">
    <Clock className="w-3.5 h-3.5 mr-1.5" />
    {state.suspensions.length} 个等待中
  </Button>
)}
```

点击打开抽屉。

#### 3.2.2 Suspensions 抽屉

新组件 `apps/web/src/components/session/suspensions-panel.tsx`:

```tsx
function SuspensionsPanel({ suspensions, onResume, onCancel }) {
  return (
    <div className="space-y-3">
      {suspensions.map(s => (
        <div key={s.id} className="border border-border p-3 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <strong>{s.pluginId} · {s.runtimeId}</strong>
            <span className="text-muted-foreground">
              {formatDistance(new Date(s.suspendedAt), new Date())}前挂起
            </span>
          </div>
          {s.reason && <p className="text-xs text-muted-foreground">{s.reason}</p>}
          <ResumeForm suspension={s} onResume={onResume} onCancel={() => onCancel(s.id)} />
        </div>
      ))}
    </div>
  );
}
```

#### 3.2.3 ResumeForm

最小可用版本:一个 textarea 让用户输入 resume data(一般是 JSON 或文本),提交到 `POST /api/sessions/:id/resume`:

```tsx
function ResumeForm({ suspension, onResume, onCancel }) {
  const [payload, setPayload] = useState('');
  const schema = suspension.expectedResumeSchema;

  return (
    <div className="space-y-2">
      {schema && (
        <pre className="text-[10px] bg-muted/40 p-2 border border-border rounded-sm">
          期望格式: {JSON.stringify(schema, null, 2)}
        </pre>
      )}
      <Textarea
        value={payload}
        onChange={(e) => setPayload(e.target.value)}
        placeholder="resume data (JSON 或文本)"
        className="font-mono text-xs"
      />
      <div className="flex gap-2">
        <Button size="sm" onClick={() => onResume(suspension.id, tryParseJson(payload) ?? payload)}>
          继续执行
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}

function tryParseJson(s: string): unknown | null {
  try { return JSON.parse(s); } catch { return null; }
}
```

#### 3.2.4 Execution timeline 里的视觉指示

[`apps/web/src/components/session/execution-timeline.tsx`](../../../apps/web/src/components/session/execution-timeline.tsx) 里,给 `status === 'suspended'` 的步骤加黄色时钟图标:

```tsx
{step.status === 'suspended' && (
  <span title="等待外部数据" className="text-amber-500">
    <Clock className="w-3 h-3" />
  </span>
)}
```

点击跳到 suspensions 抽屉对应条目。

### 3.3 阶段 3 · API client(~1h)

在 [`apps/web/src/services/api.ts`](../../../apps/web/src/services/api.ts) 加:

```ts
export async function listSuspensions(sessionId: string): Promise<SuspensionRecord[]> {
  const res = await request<{ suspensions: SuspensionRecord[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/suspensions`,
  );
  return res.suspensions;
}

export async function resumeSuspension(
  sessionId: string,
  suspensionId: string,
  resumeData: unknown,
): Promise<void> {
  await request(
    `/api/sessions/${encodeURIComponent(sessionId)}/resume`,
    {
      method: 'POST',
      body: JSON.stringify({ suspensionId, resumeData }),
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

export async function cancelSuspension(
  sessionId: string,
  suspensionId: string,
): Promise<void> {
  await request(
    `/api/sessions/${encodeURIComponent(sessionId)}/suspensions/${encodeURIComponent(suspensionId)}`,
    { method: 'DELETE' },
  );
}
```

### 3.4 阶段 4 · i18n + 测试(~1h)

#### 4.1 i18n keys

`apps/web/src/i18n/locales/{zh-CN,en-US}.json` 新增:

```json
"session": {
  "suspensionsBadge": "{{count}} 个等待中",
  "suspensionsTitle": "挂起的执行",
  "suspensionsEmpty": "没有等待中的执行。",
  "suspensionResumeLabel": "继续执行",
  "suspensionCancelLabel": "取消",
  "suspensionResumePlaceholder": "resume data(JSON 或文本)",
  "suspensionAgoSuffix": "前挂起"
}
```

#### 4.2 测试

新增 `apps/web/src/stores/__tests__/session-store-suspensions.test.ts`:

1. `turn.suspended` 事件推进 state.suspensions。
2. `turn.resumed` 事件移除对应 suspension。
3. `runtime.completed` 带 `status: 'suspended'` 时 executionStep 状态正确。
4. `listSuspensions` 初始化后 state 正确。

`apps/web/src/stores/__tests__` 已有模板可参考。

---

## 4. 风险清单

| 风险 | 缓解 |
|------|------|
| resumeData 格式因插件而异,一个 textarea 不够友好 | v1 就用 textarea + 可选展示 `expectedResumeSchema` 提示;未来可扩展成基于 schema 的动态表单(单独 ticket) |
| 过期 suspensions 堆积(resume.ts 注释已提到"A future ticket should add expire stale") | UI 默认折叠 `> 48h` 的条目并标灰;真正的后端过期策略独立处理 |
| SSE 断线重连后 suspensions 状态漂移 | 重连后重调 `listSuspensions` 对齐 |
| 多 tab 同步:A tab resume 了,B tab 不知道 | SSE `turn.resumed` 会广播给所有订阅者,自动更新 |

---

## 5. 交付物验收

- [ ] `runtime.completed` 读取真实 `payload.status`,不再硬编码 completed
- [ ] `turn.suspended` / `turn.resumed` 两个 SSE 事件在前端有 case 分支
- [ ] `session-store.suspensions` 字段存在并正确维护
- [ ] `listSuspensions` / `resumeSuspension` / `cancelSuspension` 三个 API client 函数存在
- [ ] game-view 顶栏在有挂起时显示 badge
- [ ] 点 badge 打开 suspensions 抽屉,能看到列表、resume、取消
- [ ] Execution timeline 里 suspended 步骤显示黄色时钟
- [ ] i18n keys(中英文)齐全
- [ ] 单测覆盖 reducer + API client
- [ ] `pnpm lint` + `pnpm --filter @covel/web test` 全绿

---

## 6. 参考文件清单

实施时必读:

- [`packages/shared/src/types/protocol.ts:114-116`](../../../packages/shared/src/types/protocol.ts) — 事件类型
- [`packages/runtime/src/turn-executor.ts`](../../../packages/runtime/src/turn-executor.ts) `~1540, ~2140, ~1040` — 后端 suspend/resume 路径
- [`apps/server/src/routes/api/resume.ts`](../../../apps/server/src/routes/api/resume.ts) — REST 接口
- [`apps/web/src/stores/session-store.tsx`](../../../apps/web/src/stores/session-store.tsx) — 要改的 reducer
- [`apps/web/src/services/api.ts`](../../../apps/web/src/services/api.ts) — 要加的 API client
- [`apps/web/src/components/session/game-view.tsx`](../../../apps/web/src/components/session/game-view.tsx) — badge 入口
- [`apps/web/src/components/session/execution-timeline.tsx`](../../../apps/web/src/components/session/execution-timeline.tsx) — 时钟图标
- 审计原始记录:`audits/2026-04-21-architecture-code-audit/README.md`(审计原始产出,本地 gitignored) 第 4 节

## 7. 可选延展(不在本 ticket 范围)

- 基于 `expectedResumeSchema` 的动态表单渲染(不再让用户手写 JSON)
- Suspension 过期策略:后端定时任务自动清理 > N 天的挂起
- Desktop 端 tray / 系统通知提示:长时间挂起时通知用户去处理
