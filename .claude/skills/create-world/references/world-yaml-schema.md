# world.yaml Schema Reference

Schema 使用 Zod strict 模式验证，不允许未定义字段。所有文本字段支持 I18nText（`string` 或 `Record<string, string>`）。

> **门禁注意**：I18nText 虽接受裸 `string`，但仓库的 `check-plugin-i18n` 门禁要求 `worlds/*/world.yaml` 的展示字段（`name`/`summary`/`characterAttributes[].name`/`.description` 等）必须是 `{ zh: …, en: … }` 对象——裸中文会挂 `pnpm check:plugins`。

## 根字段

| 字段                      | 类型                  | 必需 | 约束                                                    |
| ------------------------- | --------------------- | ---- | ------------------------------------------------------- |
| schemaVersion             | string                | ✓    | 当前示例推荐 `"1.0"`；schema 接受非空字符串             |
| id                        | string                | ✓    | kebab-case，正则 `^[a-z][a-z0-9-]*$`                    |
| name                      | I18nText              | ✓    |                                                         |
| version                   | string                |      | semver 格式                                             |
| summary                   | I18nText              | ✓    | 1-2 句话                                                |
| defaultLocale             | string                | ✓    | BCP-47，如 `zh-CN`                                      |
| supportedLocales          | string[]              |      | 至少 1 个                                               |
| tags                      | string[]              |      | 类型标签                                                |
| requiredPlugins           | string[]              |      | 必需插件 ID                                             |
| recommendedPlugins        | string[]              |      | 推荐插件 ID                                             |
| excludedPlugins           | string[]              |      | 排除插件 ID                                             |
| pluginPolicy              | object                |      | 会话准备页的插件策略，见下方                            |
| worldData                 | string                |      | world data descriptor 路径，通常 `data/world.data.yaml` |
| characterBlueprintSources | string[]              |      | 旧式角色蓝图路径；声明 worldData 时通常不用             |
| defaultViewMode           | enum                  |      | `stage` \| `parsed`（缺省 parsed）。视觉小说/对话世界声明 `stage` 进全屏舞台模式（背景图 + 立绘 + 打字机对话框），玩家可随时切回 |
| characterAttributes       | array                 |      | 世界声明的角色属性 schema（id/name/type/category/min/max…），world-init 原样采用，创角表单与右面板据此渲染 |
| pluginSettings            | object                |      | 插件 userSettings 的世界级默认值，如 `cost-gate: { softTokens: 400000 }`，玩家可在设置里覆盖 |
| memoryBlocks              | array                 |      | 世界声明的 core-memory 块（`label` / `displayName` / `extractionHint` 必需，`icon` / `maxChars` 可选），叠加在框架/插件块之上 |
| dimensions                | object                |      | 见下方 9 个维度                                         |
| dimensionSources          | Record<string,string> |      | 外置 dimension 文件路径，key 必须是 dimensions 的有效键 |

## pluginPolicy

`pluginPolicy` 描述世界希望启用的插件组合。两个内置世界都使用它，前端会把它与顶层的 `requiredPlugins` / `recommendedPlugins` / `excludedPlugins` 合并。

```yaml
pluginPolicy:
  preset: traditional-story # 可选：traditional-story / dialogue-mode / low-cost
  preferTags: # 可选，优先启用带这些 tags 的插件
    - mode:traditional-story
    - role:codex
  avoidTags: # 可选，降低或排除这些 tags
    - mode:dialogue
  requireCapabilities: # 可选，要求能力标签
    - narrative
  requiredPlugins: # 可选，策略级必需插件
    - narrator
  recommendedPlugins: # 可选，策略级推荐插件
    - guide
  excludedPlugins: # 可选，策略级排除插件
    - chat-mode-narrator
  packs: # 可选，自定义组合包
    - id: custom-dialogue
      label: 对话模式
      description: 以角色对话推进剧情
      plugins: [chat-mode-narrator, scene-cast]
      optionalPlugins: [branch-reply]
      excludedPlugins: [narrator]
      tags: [mode:dialogue]
      reason: 更适合校园/群像世界
```

### 内置 preset 的实际组成

`preset` 只有三个合法值，各自的插件清单定义在 `apps/web/src/lib/session-plugin-selection.ts` 的 `BUILTIN_PLUGIN_PACKS`。**改这份文件前先去那里对一遍**——它是真相源，下表是快照：

| preset              | plugins（默认启用）                                                                                                              | optional        | excluded                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------- |
| `traditional-story` | pregame, world-init, char-creator, narrator, guide, codex, npc-graph, living-world-rules                                          | memory          | chat-mode-narrator, scene-cast, scene-prompts, branch-reply |
| `dialogue-mode`     | pregame, world-init, char-creator, chat-mode-narrator, scene-cast, scene-stage, scene-prompts, character-blueprint, character-presence, living-world-rules, branch-reply | memory, npc-graph | narrator, guide, codex                            |
| `low-cost`          | pregame, world-init, char-creator, narrator, living-world-rules, cost-gate                                                        | memory          | guide, codex, scene-prompts                       |

声明 `preset` 就已经拿到上表的组合，顶层 `requiredPlugins` / `recommendedPlugins` / `excludedPlugins` 只用来**增补或推翻**其中几项，不必整份复述：

**二选一**——下面是两套互斥配置，各自完整，不要合并进同一份 `world.yaml`（`pluginPolicy` 写两遍的话 YAML 只保留后一个）。

传统故事模式（preset 已包含 narrator / guide / codex / npc-graph）：

```yaml
pluginPolicy:
  preset: traditional-story
  preferTags: [mode:traditional-story, role:codex, role:retrieval, role:world-rules]
  avoidTags: [mode:dialogue]
recommendedPlugins: [affinity] # preset 之外额外想要的
```

对话 / 视觉小说模式（参考 `worlds/haruka-academy`）：

```yaml
defaultViewMode: stage # 全屏舞台：场景背景 + 角色立绘 + 打字机对话框
pluginPolicy:
  preset: dialogue-mode
  preferTags: [mode:dialogue, role:character, role:world-rules]
  avoidTags: [mode:traditional-story]
```

当前仓库共 23 个插件，跑 `ls plugins/` 拿准确清单。**schema 不校验插件 ID**，写了不存在的名字要到建会话时才报错。

舞台模式的数据链：`chat-mode-narrator` 经 `emit-event` 发 `scene.set` → `scene-stage` 解析场景/昼夜、命中世界场景注册表或按需生成背景 → `scene-cast` 决定在场说话人 → `character-presence` 提供立绘。**没有场景/立绘资产也能跑**（回退世界头图 + 名字占位卡），资产是渐进增强——见下方 worldData 小节。

## worldData

`worldData` 指向 `data/world.data.yaml`，用于会话创建时导入结构化世界资料。权威说明见 `docs/reference/world-data.md`。descriptor schema 同样是 strict 模式：

```yaml
schemaVersion: 1 # 字面量数字 1，不是字符串
sources:
  dimensions: # source id 正则 ^[a-z][a-zA-Z0-9_-]{0,63}$
    kind: yaml # yaml|json|markdown|text|media
    path: data/dimensions.yaml
    schema: covel://world/dimensions # 可选，校验用
    to: world:metadata.dimensions
  cast:
    kind: json
    path: characters/main-cast.json
    schema: plugin://character-blueprint/blueprints
    to: plugin:character-blueprint/blueprints
    key: id # 可选，条目主键字段
    indexTo: lorebook # 可选，附加投影目标
    effects: [characters] # 可选，唯一合法值就是 characters
    enabled: true # 可选，false 则跳过这条 source
    locale: zh-CN # 可选，把这条 source 绑定到某个 locale
    merge: replace # 可选：replace|skipExisting
    after: dimensions # 可选：string 或 string[]，声明导入顺序
```

`to` 的合法目标（解析器在 `apps/server/src/world-data/target-uri.ts`）：

- `world:metadata.<path>` — 写入世界 metadata；**只有 `world:metadata.dimensions` 会在世界加载期真正投影**，其它 metadata 路径此时只记进 summary（warning），实际写入发生在建会话导入阶段
- `plugin:<plugin-id>/<namespace>` — 写入插件 plugin-data
- `plugin:<plugin-id>/<namespace>+lorebook` — 写入插件数据并投影 lorebook
- `lorebook` — 写 lorebook 常量词条
- `characters` — 写角色记录
- `media` — 导入媒体资产

目标插件未被玩家启用时该 source 自动跳过（warning，不阻断建会话）——给可选插件带数据是安全的，但要让数据默认生效，记得让目标插件进入所选 preset 或 `recommendedPlugins`。

**source 文件也走 locale 解析**：`path` 指向 `foo.json` 时，读取顺序是 `foo.<lang>.json` → `foo.json`，与 `WORLD.md` 的规则一致（`apps/server/src/world-data/source-reader.ts`）。要给某份数据做本地化变体，直接放 `foo.en.json` 即可，不必新增 source。

### 视觉小说资产管线（立绘 + 场景背景，参考 worlds/haruka-academy）

```yaml
sources:
  portraits: # 角色立绘 PNG → 媒体库 + character-presence 索引
    kind: media
    path: media/portraits
    to: media
    indexTo: plugin:character-presence/assets
    key: filename
    after: cast
  presence: # characterId → 立绘/头像 MediaRef 映射（sha256 必须与图内容一致）
    kind: json
    path: media/presence.json
    schema: plugin://character-presence/presence
    to: plugin:character-presence/presence
    key: characterId
    after: portraits
  scenes: # 场景背景 PNG（日/夜变体）→ 媒体库 + scene-stage 索引
    kind: media
    path: media/scenes
    to: media
    indexTo: plugin:scene-stage/assets
    key: filename
    after: dimensions
  scenesRegistry: # sceneId → {day, night} MediaRef 注册表
    kind: json
    path: media/scenes.registry.json
    schema: plugin://scene-stage/scenes
    to: plugin:scene-stage/scenes
    key: registryId
    after: dimensions
```

图片与 JSON 索引不必手写：`scripts/generate-portraits.mjs` / `generate-scenes.mjs` 按世界的 `portraits.json` / `scenes.json` 描述批量出图，`emit-presence.mjs` / `emit-scenes.mjs` 从图片自动生成带 sha256 的索引 JSON（**重生成图片后必须重跑**）。提示词与流程详见 `docs/guide/world-portraits.md` 与 `docs/guide/world-scenes.md`。未命中注册表的场景由 `scene-stage/background-gen` 会话内按需生成（玩家可用 `autoGenerateScenes` / `maxGeneratedScenes` 设置控制）。

## dimensions.geography

```yaml
geography:
  overview: <I18nText> # 可选
  regions: # 必需，至少 1 个
    - name: <I18nText> # 必需
      description: <I18nText> # 必需
      climate: <I18nText> # 必需
      landmarks: # 可选
        - name: <I18nText>
          description: <I18nText> # 可选
```

## dimensions.factions

```yaml
factions: # 数组
  - id: <kebab-case> # 必需，正则 ^[a-z][a-z0-9-]*$
    name: <I18nText> # 必需
    description: <I18nText> # 必需
    type: <enum> # 必需：political|guild|corporate|religious|criminal|military|other
    influence: <enum> # 必需：major|minor
    leader: <I18nText> # 可选
    headquarters: <I18nText> # 可选
    relations: # 可选
      - type: <string> # 如 hostile|neutral|allied
        targetId: <string> # 其他 faction 的 id
        description: <I18nText> # 可选
```

## dimensions.powerSystem

```yaml
powerSystem:
  name: <I18nText> # 必需
  type: <enum> # 必需：magic|technology|cultivation|psychic|hybrid|other
  description: <I18nText> # 必需
  rules: # 必需，至少 1 条，每条为 I18nText
    - <I18nText>
  tiers: # 可选
    - name: <I18nText>
      rank: <int, ≥1> # 必需
      description: <I18nText> # 可选
```

## dimensions.history

```yaml
history: # 数组
  - name: <I18nText> # 必需
    description: <I18nText> # 必需
    significance: <enum> # 必需：major|minor
    era: <I18nText> # 可选
    year: <I18nText> # 可选
```

## dimensions.economy

```yaml
economy:
  currencies: # 必需，至少 1 个
    - name: <I18nText> # 必需
      symbol: <string> # 可选
      description: <I18nText> # 可选
  resources: # 可选，I18nText 数组
    - <I18nText>
  tradeNotes: <I18nText> # 可选
```

## dimensions.socialStructure

```yaml
socialStructure:
  classes: # 可选
    - name: <I18nText> # 必需
      description: <I18nText> # 必需
      rank: <int> # 可选
  races: # 可选
    - name: <I18nText>
      description: <I18nText>
      traits: [<I18nText>] # 可选
  notes: <I18nText> # 可选
```

## dimensions.tone

```yaml
tone:
  genres: # 必需，至少 1 个，I18nText 数组
    - <I18nText>
  contentRating: <enum> # 必需：all-ages|teen|mature
  narrativeStyle: <I18nText> # 可选
  themes: # 可选，I18nText 数组
    - <I18nText>
```

## dimensions.mechanics

```yaml
mechanics:
  combatStyle: <enum> # 可选：turn-based|real-time|narrative|none
  difficulty: <enum> # 可选：easy|normal|hard|adaptive
  skillSystem: <I18nText> # 可选
  customRules: # 可选，I18nText 数组
    - <I18nText>
```

## dimensions.startingConditions

```yaml
startingConditions:
  openingScenario: <I18nText> # 必需，2-3 句呈现即时紧张感
  startingLocation: <I18nText> # 可选
  playerConstraints: # 可选，I18nText 数组
    - <I18nText>
  startingResources: # 可选，Record<string, number>
    <资源名>: <数量>
  openingHook: <I18nText> # 可选，开场短钩子
  openingChips: # 可选，开场快捷行动建议
    - <I18nText>
```

## 文件结构

```
worlds/<id>/
├── world.yaml            # 必需
├── WORLD.md              # 必需，默认 lore（所有 locale 的兜底）
├── WORLD.<lang>.md       # 可选，某个 locale 的覆盖版本
├── data/
│   ├── world.data.yaml   # worldData descriptor（推荐）
│   ├── dimensions.yaml   # 外置维度（两个内置世界的做法）
│   └── rules/            # living-world-rules 规则包
├── characters/           # 角色蓝图 JSON
└── media/                # 立绘 / 场景背景 + 索引 JSON
```

lore 解析链 **`WORLD.<lang>.md` → `WORLD.md` → 空字符串**（`apps/server/src/world-seed-loader.ts`）。`WORLD.md` 缺了会让所有没有对应 `WORLD.<lang>.md` 的 locale 拿到空 lore；`pnpm release:preflight` 只检查"至少有一个 `WORLD*.md`"，兜不住这个坑。
