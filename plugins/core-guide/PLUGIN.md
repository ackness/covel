# core-guide

Generates structured choice panels and action suggestion guides at narrative decision points.

You have TWO tools available. You MUST call exactly ONE tool, exactly ONCE per turn. Never call both tools. Never call the same tool more than once.

## Tool: generate-choices

Use for **simple decision points** where the player picks one clear option.

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

## Tool: generate-action-guide

Use for **open-ended situations** where the player benefits from diverse, categorized suggestions across different playstyles.

Parameters:
- `topic` (string, required): Concise description of the current situation
- `categories` (array, required): 1-4 suggestion categories, each with:
  - `style` ("safe" | "aggressive" | "creative" | "wild", required): Playstyle category
  - `label` (string, optional): Custom label (defaults to style name)
  - `suggestions` (string[], required): 1-4 actionable suggestions

Styles:
- **safe** — cautious, low-risk approaches
- **aggressive** — direct, confrontational approaches
- **creative** — unconventional, clever approaches
- **wild** — high-risk, unpredictable approaches

Example:
```json
{
  "topic": "深夜被困在废弃城堡中",
  "categories": [
    {
      "style": "safe",
      "suggestions": ["找一间可以上锁的房间躲到天亮", "沿着来路原路返回"]
    },
    {
      "style": "aggressive",
      "suggestions": ["直接探索城堡深处寻找出口", "点燃火把驱散阴影"]
    },
    {
      "style": "creative",
      "suggestions": ["检查墙上的画像寻找暗门线索", "用随身物品制作简易陷阱"]
    },
    {
      "style": "wild",
      "suggestions": ["大声呼喊试图引出城堡的主人"]
    }
  ]
}
```

## When to Use Which

| Situation | Tool |
|-----------|------|
| NPC asks a question requiring response | `generate-choices` |
| Binary or ternary decision with clear outcomes | `generate-choices` |
| New scene, open exploration | `generate-action-guide` |
| Complex situation with multiple approaches | `generate-action-guide` |
| High-risk moment needing risk assessment | `generate-action-guide` |
| Player seems stuck or unsure what to do | `generate-action-guide` |

## Guidelines

- Do NOT generate suggestions on every response. Only when the player needs direction.
- If the player is executing a clear action, just advance the narrative.
- Each suggestion should be specific and actionable, not vague.
- For `generate-action-guide`, include at least 2 categories to provide contrast.
- The `wild` category is optional — include it only when a truly unexpected option exists.
- After calling either tool, do NOT output any additional text. The tool call is your only output.
- **CRITICAL: Call exactly ONE tool, exactly ONCE. Multiple tool calls will produce duplicate UI blocks.**
