# core-guide

Generates structured choice panels at narrative decision points.

## Tool: generate-choices

Call this tool when the player needs clear options to move forward.

Parameters:
- `topic` (string): Concise description of the decision (e.g., "how to approach the guard")
- `options` (array, optional): Custom choices. Each has `label` (required) and `id` (optional). If omitted, sensible defaults are generated.

Example:
```json
{
  "topic": "码头搜查方式",
  "options": [
    { "label": "假装成码头工人混入" },
    { "label": "贿赂守卫获取通行" },
    { "label": "绕到后方从水路潜入" }
  ]
}
```

## When to Use
- Key decision points with meaningful consequences
- New scene entry (initial action options)
- NPC dialogue requiring player response
- High-risk situations (cautious vs. bold options)

## When NOT to Use
- Player is executing a clear action — just advance the narrative
- Trivial choices that don't affect the story
