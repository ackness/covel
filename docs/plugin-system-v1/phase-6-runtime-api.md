# Phase 6: Runtime 独立调用 API

依赖：Phase 3-5  
位置：`apps/server/` 新增路由

## 目标

让 runtime 除了能被 turn pipeline 调度外，也能被前端或外部系统独立调用。

典型场景：

- 手动触发图片生成
- 单独调试某个 runtime
- 审批回调后恢复执行

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

## 3. 查询最近结果

```http
GET /api/sessions/:sessionId/runtimes/:pluginId/:runtimeId/last-record
```

返回最近一次 published record，而不是内部 proposals 或原始 trace。

## 4. 审批回调

```http
POST /api/sessions/:sessionId/approvals/callback
```

用途：

- 用户在前端批准某个 `session + plugin + tool`
- 系统触发 `approval.callback`
- 可继续唤起等待中的 runtime 或后续 runtime

## 5. API 设计约束

- API 对外返回的是标准化记录
- 不直接返回底层 trace 原始结构
- standalone runtime 执行也必须写入 trace
- standalone runtime 执行也必须生成 published record
