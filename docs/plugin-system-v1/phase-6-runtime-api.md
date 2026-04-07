# Phase 6: Runtime 独立调用 API

依赖：Phase 3-5  
位置：`apps/server/` 新增路由

## 目标

让 runtime 除了能被 turn pipeline 调度外，也能被前端或外部系统独立调用。

典型场景：

- 手动触发图片生成
- 单独调试某个 runtime
- 审批回调后恢复执行
- 通过插件声明的 action 启动异步多 runtime workflow

## 1. API 端点

### 1.1 执行 Runtime

```http
POST /api/sessions/:sessionId/runtimes/:pluginId/:runtimeId/execute
```

### Request

```json
{
  "trigger": {
    "type": "manual",
    "action": "image.generate",
    "payload": {
      "prompt": "Draw the current scene"
    }
  },
  "slotOverrides": {
    "image": "gpt-image-1.5-pro"
  }
}
```

### Response

返回该次执行生成的标准化 published record：

```json
{
  "traceId": "trace-123",
  "record": {
    "recordType": "runtime_result",
    "pluginId": "core-image",
    "runtimeId": "image-gen",
    "sessionId": "session-1",
    "turnId": "manual-turn-12",
    "runId": "run-9",
    "status": "success",
    "timestamp": "2026-04-07T15:00:00.000Z",
    "locale": "en-US",
    "payload": {
      "imageUrl": "https://..."
    }
  }
}
```

## 2. 列出可用 Runtime

```http
GET /api/sessions/:sessionId/runtimes
```

返回：

- pluginId
- runtimeId
- priority
- trigger
- settings schema
- 可用 system tools
- 已解析导入的外部 tools

## 3. 执行插件 Action

```http
POST /api/sessions/:sessionId/actions/:pluginId/:actionId/execute
```

### Request

```json
{
  "payload": {
    "messageId": "msg-123",
    "style": "cinematic"
  }
}
```

### Response

```json
{
  "workflowRunId": "wf-001",
  "status": "queued",
  "currentStep": null
}
```

说明：

- 适用于插件在 `plugin.json` 中声明的统一前端 action
- 对异步 workflow，前端不需要阻塞等待最终图片

## 4. 查询 workflow 状态

```http
GET /api/sessions/:sessionId/workflows/:workflowRunId
```

### Response

```json
{
  "workflowRunId": "wf-001",
  "pluginId": "image-workflow-demo",
  "actionId": "generate-story-image",
  "status": "running",
  "currentStep": "image-generator",
  "steps": [
    {
      "runtimeId": "prompt-optimizer",
      "status": "completed"
    },
    {
      "runtimeId": "image-generator",
      "status": "running"
    }
  ],
  "progressLabel": "图片生成中"
}
```

## 5. 查询最近结果

```http
GET /api/sessions/:sessionId/runtimes/:pluginId/:runtimeId/last-record
```

返回最近一次 published record，而不是内部 proposals 或原始 trace。

## 6. 审批回调

```http
POST /api/sessions/:sessionId/approvals/callback
```

用途：

- 用户在前端批准某个 `session + plugin + tool`
- 系统触发 `approval.callback`
- 可继续唤起等待中的 runtime 或后续 runtime

## 7. API 设计约束

- API 对外返回的是标准化记录
- 不直接返回底层 trace 原始结构
- standalone runtime 执行也必须写入 trace
- standalone runtime 执行也必须生成 published record
- workflow action 也必须写入 trace
- workflow 中每个 runtime 都必须生成自己的 published record
