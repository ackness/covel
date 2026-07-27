# world.yaml 格式样例

下面是一个虚构世界的缩略 manifest，用来示范字段结构和写作风格。**插件 ID 是真实存在的**——照抄前仍应 `ls plugins/` 复核。

```yaml
schemaVersion: "1.0"
id: cloudmere
name: 九州・云梦泽
version: "0.1.0"
summary: 修仙世界，灵气复苏，宗门林立。你是偏僻小宗的外门弟子。
defaultLocale: zh-CN
supportedLocales:
  - zh-CN
tags:
  - xianxia
  - adventure
  - political-intrigue

pluginPolicy:
  preset: traditional-story
  preferTags: [mode:traditional-story, role:codex, role:world-rules]
  avoidTags: [mode:dialogue]
recommendedPlugins:
  - player-identity

dimensions:
  geography:
    overview: 九州大陆东南的广袤灵域，水汽充沛、灵气浓郁。
    regions:
      - name: 青萍山
        description: 青萍宗所在的灵脉山峰，山腰以下是外门，山顶是内门禁地。
        climate: 四季如春，常有灵雾缭绕
        landmarks:
          - name: 试炼场
            description: 年度试炼大会的比武场地。
      - name: 云梦泽深处
        description: 未经开发的原始灵域，瘴气与灵兽并存。
        climate: 湿热多瘴
      - name: 灵渡镇
        description: 各宗门势力交汇的中立市镇。
        climate: 温和湿润

  factions:
    - id: qingping-sect
      name: 青萍宗
      description: 偏居一隅的中小宗门，擅水系法术与灵植培育。
      type: guild
      influence: minor
      leader: 宗主・陆沉渊（金丹后期）
      headquarters: 青萍山
    - id: tianji-pavilion
      name: 天机阁
      description: 云梦泽最强宗门，以炼丹术闻名天下。
      type: guild
      influence: major
      leader: 阁主・玄清子（元婴期）
      relations:
        - targetId: heiyuan-sect
          type: hostile
          description: 暗中争夺灵脉控制权
    - id: heiyuan-sect
      name: 黑渊宗
      description: 行事阴狠的宗门，修炼偏门功法。
      type: guild
      influence: major

  powerSystem:
    name: 灵气修炼
    type: cultivation
    description: 吸纳天地灵气淬炼己身。
    rules:
      - 修炼需功法、灵石和天赋
      - 灵脉附近灵气浓郁，修炼效率倍增
      - 跨境界突破需机缘与资源
    tiers:
      - name: 练气
        rank: 1
      - name: 筑基
        rank: 2
      - name: 金丹
        rank: 3
      - name: 元婴
        rank: 4

  tone:
    genres: [xianxia, adventure]
    contentRating: teen
    narrativeStyle: 古风仙侠笔触，山水灵秀中暗藏宗门权谋。

  mechanics:
    combatStyle: turn-based
    difficulty: normal

  startingConditions:
    openingScenario: >-
      试炼大会三日后举行，你正在坊市采购备战物资。师姐匆匆赶来，说她在云梦泽深处发现了一处野生灵脉。消息若泄露，各大宗门必定争抢。她问你：大会之前，要不要先去探查？
    playerConstraints:
      - 初始为练气三层，水灵根
      - 仅限使用青萍宗入门功法
    startingLocation: 青萍山・坊市
    startingResources:
      下品灵石: 30
      丹药: 3
```

要点：

- history、economy、socialStructure 为节省篇幅省略了，真实世界应当写全
- 所有 id 字段用 kebab-case 英文，其余内容用中文
- 这里把 `dimensions` 内联进 manifest，适合小世界；**仓库里两个真实世界都不是这么做的**——见下

## 真实成品参考（在仓库内，随框架同步更新）

对着这两个看，比对着上面的缩略示例看更准：

| 世界                    | 风格                                | 值得抄的部分                                                                                                                       |
| ----------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `worlds/mistport`       | 传统叙事                            | 完整 worldData 管线（`data/dimensions.yaml` 外置维度 + 角色蓝图 + 世界规则 + 立绘 presence）、`pluginSettings` / `memoryBlocks` / `characterAttributes`、`WORLD.en.md` + `WORLD.zh.md` 双语 lore |
| `worlds/haruka-academy` | **视觉小说**（`defaultViewMode: stage`） | 对话模式插件集、立绘 + 场景背景资产管线（`media/portraits` + `media/scenes` + 双注册表 JSON）                                        |

两个世界的 `data/world.data.yaml` 都很短（1KB 上下），是 worldData descriptor 最好的模板——直接读。

`worlds/_archive/` 下的世界（`cloudmere` / `neonridge`）**不会被加载**，只当历史参考，不要当作可运行样例引用。
