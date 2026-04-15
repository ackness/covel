# world.yaml Schema Reference

Schema 使用 Zod strict 模式验证，不允许未定义字段。所有文本字段支持 I18nText（`string` 或 `Record<string, string>`）。

## 根字段

| 字段 | 类型 | 必需 | 约束 |
|------|------|------|------|
| schemaVersion | string | ✓ | 固定 `"1.0"` |
| id | string | ✓ | kebab-case，正则 `^[a-z][a-z0-9-]*$` |
| name | I18nText | ✓ | |
| version | string | | semver 格式 |
| summary | I18nText | ✓ | 1-2 句话 |
| defaultLocale | string | ✓ | BCP-47，如 `zh-CN` |
| supportedLocales | string[] | | 至少 1 个 |
| tags | string[] | | 类型标签 |
| requiredPlugins | string[] | | 必需插件 ID |
| recommendedPlugins | string[] | | 推荐插件 ID |
| dimensions | object | | 见下方 9 个维度 |

## dimensions.geography

```yaml
geography:
  overview: <I18nText>           # 可选
  regions:                       # 必需，至少 1 个
    - name: <I18nText>           # 必需
      description: <I18nText>    # 必需
      climate: <I18nText>        # 必需
      landmarks:                 # 可选
        - name: <I18nText>
          description: <I18nText>  # 可选
```

## dimensions.factions

```yaml
factions:                        # 数组
  - id: <kebab-case>             # 必需，正则 ^[a-z][a-z0-9-]*$
    name: <I18nText>             # 必需
    description: <I18nText>      # 必需
    type: <enum>                 # 必需：political|guild|corporate|religious|criminal|military|other
    influence: <enum>            # 必需：major|minor
    leader: <I18nText>           # 可选
    headquarters: <I18nText>     # 可选
    relations:                   # 可选
      - type: <string>           # 如 hostile|neutral|allied
        targetId: <string>       # 其他 faction 的 id
        description: <I18nText>  # 可选
```

## dimensions.powerSystem

```yaml
powerSystem:
  name: <I18nText>               # 必需
  type: <enum>                   # 必需：magic|technology|cultivation|psychic|hybrid|other
  description: <I18nText>        # 必需
  rules:                         # 必需，至少 1 条，每条为 I18nText
    - <I18nText>
  tiers:                         # 可选
    - name: <I18nText>
      rank: <int, ≥1>            # 必需
      description: <I18nText>    # 可选
```

## dimensions.history

```yaml
history:                         # 数组
  - name: <I18nText>             # 必需
    description: <I18nText>      # 必需
    significance: <enum>         # 必需：major|minor
    era: <I18nText>              # 可选
    year: <I18nText>             # 可选
```

## dimensions.economy

```yaml
economy:
  currencies:                    # 必需，至少 1 个
    - name: <I18nText>           # 必需
      symbol: <string>           # 可选
      description: <I18nText>    # 可选
  resources:                     # 可选，I18nText 数组
    - <I18nText>
  tradeNotes: <I18nText>         # 可选
```

## dimensions.socialStructure

```yaml
socialStructure:
  classes:                       # 可选
    - name: <I18nText>           # 必需
      description: <I18nText>    # 必需
      rank: <int>                # 可选
  races:                         # 可选
    - name: <I18nText>
      description: <I18nText>
      traits: [<I18nText>]       # 可选
  notes: <I18nText>              # 可选
```

## dimensions.tone

```yaml
tone:
  genres:                        # 必需，至少 1 个，I18nText 数组
    - <I18nText>
  contentRating: <enum>          # 必需：all-ages|teen|mature
  narrativeStyle: <I18nText>     # 可选
  themes:                        # 可选，I18nText 数组
    - <I18nText>
```

## dimensions.mechanics

```yaml
mechanics:
  combatStyle: <enum>            # 可选：turn-based|real-time|narrative|none
  difficulty: <enum>             # 可选：easy|normal|hard|adaptive
  skillSystem: <I18nText>        # 可选
  customRules:                   # 可选，I18nText 数组
    - <I18nText>
```

## dimensions.startingConditions

```yaml
startingConditions:
  openingScenario: <I18nText>    # 必需，2-3 句呈现即时紧张感
  startingLocation: <I18nText>   # 可选
  playerConstraints:             # 可选，I18nText 数组
    - <I18nText>
  startingResources:             # 可选，Record<string, number>
    <资源名>: <数量>
```

## 文件结构

```
worlds/<id>/
├── world.yaml       # 必需
├── WORLD.md         # 默认 lore（fallback）
├── WORLD.zh.md      # 中文 lore
└── WORLD.en.md      # 英文 lore（可选）
```
