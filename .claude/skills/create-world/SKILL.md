---
name: create-world
description: 创建 Covel 世界包。根据用户概念直接生成 world.yaml + WORLD.md 写入 worlds/ 目录并验证。当用户想创建新世界、新地图、新世界观设定、或者说"帮我搞一个 XX 风格的世界"时使用。
---

# 创建 Covel 世界

根据用户的世界观概念，生成完整的世界包并写入 `worlds/`。

字段表、数据契约和插件清单**不写在这个 skill 里**。每次都向当前版本查询，这样框架和插件更新后这里不用改，也不会过期。

## 流程

### 1. 理解概念

用户给出概念后，如果足够清晰就直接开始。如果模糊，最多追问 1-2 个问题（不要追问技术参数——id、tags 等由你自主决定）：

- 核心冲突是什么？
- 力量体系偏哪种？

### 2. 查询当前版本能写什么

```bash
pnpm describe:authoring
```

输出包含：

- 世界包有哪些文件，各自的字段表在哪。
- 内置数据目标：维度、角色。
- 每一种可以预置的内容：标题、接收它的插件、写作提示、文件该放的路径（`path`）、一份合法示例。
- 插件目录：ID、简介、提供和依赖的契约、可以用 `pluginSettings` 预置的设置项。

只使用这里列出的插件 ID、契约和设置项。需要机器可读的结果时加 `--json`；社区插件用 `--plugins <dir>` 一并扫描。

### 3. 选玩法和内容

- 按玩法选 `pluginPolicy.presetId`：传统叙事 `traditional-story`，对话/校园/群像 `dialogue-mode`，省 token `low-cost`。
- 从第 2 步的内容列表里挑与概念相符的。要预置某种内容，就把接收它的插件写进 `pluginPolicy.requested`。
- 视觉小说世界再声明 `defaultViewMode: stage`。立绘和场景图是渐进增强，没有也能运行。

成品参考（直接读这些目录，它们随框架同步更新）：

| 世界                    | 玩法                         |
| ----------------------- | ---------------------------- |
| `worlds/mistport`       | 传统叙事调查剧，含隐藏剧情   |
| `worlds/haruka-academy` | 视觉小说，立绘加场景背景     |
| `worlds/emberback`      | RPG：判定、任务、背包、好感  |
| `worlds/lantern-barrow` | 跑团：开局配点加掷骰检定     |

`worlds/_archive/` 下的世界不会被加载，不要当作样例。

### 4. 写文件

```
worlds/<id>/
├── world.yaml            # 字段表：docs/reference/schema/world-manifest.md
├── WORLD.md              # 默认 lore（800-1500 字），所有语言的兜底
├── WORLD.<lang>.md       # 可选，只在真的提供第二语种时写
├── data/
│   ├── dimensions.yaml   # 见 references/dimensions.md
│   └── …                 # 每种内容一个文件，路径用第 2 步给出的 path
└── characters/, media/   # 同上，按第 2 步的 path
```

文件放在第 2 步给出的路径上就会被导入，不需要 `data/world.data.yaml`，`world.yaml` 里也不写 `worldData`。只有文件不在约定路径上、一种内容有多个文件、或要指定导入顺序时才写 descriptor（见 `docs/reference/world-data.md` 的“按约定导入”）；写了之后只认 descriptor，要把所有 source 列全。

要求：

- `world.yaml` 第一行写 `# yaml-language-server: $schema=../../packages/shared/schemas/world-manifest.schema.json`，编辑器会给出补全和报错。
- 每个数据文件按第 2 步的写作提示和示例来写。
- 多个文件提到同一个角色、物品或地点时，使用完全相同的 ID 和名字，并与 `WORLD.md` 一致。
- 角色类型和属性写在 `characterSchema: {types, attributes}`。
- 所有 ID（world id、source id、记录 id）用 kebab-case 英文。
- 避免泛化的奇幻套路，追求独特的设定。
- 用户给了署名信息时，在 `world.yaml` 写 `author`（`name`，可选 `url`、`about`、`links`）、`license`、`homepage`；没给就不写，不要编造作者或链接。链接只能是 `https`。作者名和许可证不翻译，`about` 和链接的 `label` 可以在 `world.<locale>.yaml` 里翻译。字段见 `docs/reference/plugins.md` 的“作者信息”。
- 每个文件只写一种语言（`world.yaml` 的 `defaultLocale`）。要加别的语言时，在文件旁边放 `<名字>.<locale>.<扩展名>`，只写译文、不重复结构：`world.en.yaml`、`data/dimensions.en.yaml`、`characters/main-cast.en.json`；`WORLD.en.md` 是整份正文。主文件里不要写 `{ zh: …, en: … }` 这样的内联映射，校验会报错。
- 写进本仓库 `worlds/` 的中文世界，`world.yaml` 的展示字段（`name`、`summary`、属性的 `name` / `description` 等）必须在 `world.en.yaml` 里有英文译文，仓库门禁会检查。`WORLD.md` 和 `data/` 里的内容用用户的语言即可。

### 5. 验证

```bash
pnpm validate:world worlds/<id>
```

它校验清单、lore、插件 ID 和契约，并按接收插件的 schema 逐条校验每个数据文件。每条诊断带文件、位置和修法。有 error 就按提示改完重跑，直到通过；warning 逐条判断是否需要处理。

世界写进本仓库时再跑 `pnpm check:plugins`。准备对外发布时，按 `references/world-validation.md` 做引用一致性、lore 覆盖度和真实跑一回合的检查。

### 6. 展示结果

给用户一个简洁摘要：世界名称、地区数、阵营数、力量体系、开场场景、预置了哪些内容、校验结果。问是否需要调整。

## References

- `references/dimensions.md`：怎么写维度，含一份经 CI 校验的示例。
- `references/world-validation.md`：校验器的检查项，以及发布前的人工检查。

权威文档是 `docs/reference/world-data.md`；冲突时以它和 `pnpm describe:authoring` 的输出为准。
