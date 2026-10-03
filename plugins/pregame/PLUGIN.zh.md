---
---

# Pre-Game 初始化插件

此插件是 `runtimeType: function` 类型，不调用 LLM，而是直接执行 `handler.js` 中的纯函数。

## 执行时机

`stage: setup`——仅在 `session.phase === "setup"` 时调度，报告完成后不再运行（maxTriggerCount: 1 是重试预算）。完成状态记录在 `session.setupRuntimes` 镜像。

## 职责

1. 读取世界信息构建欢迎通知
2. 返回 narrativeOutput 给后续插件作为上下文
3. 报告 `completion: "done"`，全部 setup 完成后内核把 `phase` 翻到 playing

## Handler 返回值

```json
{
  "outcome": "success",
  "value": {
    "narrativeOutput": "世界观摘要文本...",
    "initialized": true
  },
  "effects": {
    "notifications": [{ "level": "info", "title": "...", "message": "..." }]
  },
  "completion": "done"
}
```

RuntimeResult 的 `output` 保存 `value` 的业务内容，`effects` 保存通知，`completion` 保存准备阶段的完成信号。
