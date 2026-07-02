# 场景资产管线（Scene Asset Pipeline）设计

> GalGame 对话模式三部曲的第一步（A）。后续：B 场景解析运行时、C GalGame 舞台 UI——各自另立规格。
> 北极星：**作者改世界包顺手（清单可手编、脚手架代劳、dry-run 先审后花钱）；玩家体验不因缺资产而破碎（每一层都有默认回退）。**

## 背景

- 实时图像生成单张 60-180s，不能在对话回合内等图 → 背景图必须预生成，运行时只做"查表 + 异步补图"。
- 立绘管线已存在且成熟：`portraits.json`（生成清单，style.prefix + subject + suffix 模板拼接）→ `generate-portraits.mjs`（读 llm.toml slot、并行 5、落盘 `media/portraits/`）→ `emit-presence.mjs` 生成 `presence.json`（characterId → sha256 MediaRef 注册表）→ world-data 导入注册进媒体库。
- 场景背景完全复制这套四段式：**生成清单 → 批量脚本 → 注册表 → 导入**。

## 范围

**做**：scenes.json 数据格式、generate-scenes.mjs（含 scaffold/dry-run）、场景注册表 emit、立绘透明底升级、运行时增量生成的 metadata 契约、回退链定义、haruka-academy 试点、SCENES.md 文档。

**不做（后续规格）**：场景解析运行时（B）、舞台 UI（C）、"保存到世界级"的 server API 与画廊按钮（归 C，A 只保证格式有落点）、B/C 对回退链的前端实现。

## §1 数据模型

### scenes.json（生成清单，作者手编）

`worlds/<world>/media/scenes.json`，与 portraits.json 同构：

```jsonc
{
  "world": "haruka-academy",
  "style": {
    "direction": "anime visual-novel background, painterly",
    "prefix": "Visual novel background art, no people, anime scenery style, ...",
    "suffix": ", clean composition, GalGame background, no characters",
    "negative": "people, character, text, watermark, ...",
    "nightSuffix": ", night time, moonlight, warm interior lights",
  },
  "defaults": { "size": "1536x1024", "quality": "medium", "mime": "image/png" },
  "scenes": [
    {
      "id": "classroom",
      "name": "教室",
      "locationRef": "landmark-classroom-2a", // dimensions.yaml landmark id，B 的映射锚点
      "subject": "a sunlit Japanese high-school classroom, rows of desks, ...",
      "subjectNight": "", // 可选；缺省 = subject + style.nightSuffix
    },
  ],
}
```

- 每场景固定产出两张：`media/scenes/<id>-day.png`、`<id>-night.png`。
- `locationRef` 可空（自由场景）；scaffold 从 landmarks 派生时自动填。

### 场景注册表（自动生成，勿手编）

`media/scenes.registry.json`：`sceneId → { day: MediaRef, night: MediaRef }`（sha256 寻址，同 presence.json 规则）。由 emit 步骤从 `media/scenes/` 产出；**重生成图片后必须重跑**（同 presence 的既有约定）。world.data.yaml 增加一条 media source 指向它，导入时注册进媒体库。

### 立绘透明底升级

- `portraits.json` 的 `style` 增加 `"background": "transparent"`；prefix 措辞改 isolated sprite（去掉 "neutral soft-gradient background"）。
- 脚本把 `background` 参数透传给 API（gpt-image 原生支持；不支持的模型仅靠提示词，产物照常保存——呈现降级见 §4）。
- `defaults.mime` 保持 png（透明通道）。试点世界立绘重生成一轮，重跑 emit-presence。

## §2 生成脚本

`scripts/generate-scenes.mjs`，克隆 generate-portraits.mjs 骨架：

- 共享代码下沉 `scripts/lib/image-gen-common.mjs`：readSlot（llm.toml）、readKeys（keys.env）、并行 worker 队列、落盘、`--only/--force/--limit/--concurrency/--slot` 参数解析。generate-portraits.mjs 改为复用同一 lib（顺手去重，行为不变）。
- 每个场景入队 day + night 两个任务；`--variant day|night` 可只生成一种。
- `--scaffold`：读 `data/dimensions.yaml` 的 regions/landmarks，为每个 landmark 预填草稿条目（id/name/locationRef 填好，subject 留 landmark 描述原文），**已存在的条目不覆盖**；`--scaffold-llm` 可选用文本 slot 把 subject 草拟成画面描述。
- `--dry-run`：打印完整 prompt 队列与目标文件名，不出图（单张 60-180s，先审后花钱）。
- emit 步骤：并列新增 `emit-scenes.mjs`（presence.json 的字段是角色特化的，泛化不值得；两脚本共用 §2 的共享 lib 做 sha256/落盘）。

## §3 运行时增量生成契约（A 定契约，B/C 消费）

- 通路复用现有 `image-generation` capability 插件（event 触发、`execution: background`、产物入会话 media store）——不新建机制。
- MediaRef metadata 约定：

```jsonc
{ "kind": "scene-background" | "character-sprite",
  "sceneId": "...",        // 或 characterId
  "variant": "day" | "night" }
```

- 查图优先级（B/C 实现遵循）：**世界包注册表 → 会话 media store 按 metadata 匹配 → 回退链（§4）**。
- 会话内生成的资产归会话；玩家可在 UI 里"保存到世界级"（落盘用户世界目录 + 回写注册表）——入口与实现归 C。

## §4 回退链（每层可缺，模式永远可玩）

| 缺什么                            | 回退到                                                 |
| --------------------------------- | ------------------------------------------------------ |
| 整个 scenes.json / 注册表         | 世界头图（现有 `worldVisual`）→ 世界主题色渐变         |
| 某场景无图                        | 同上（世界头图/渐变），同时可触发 §3 增量生成          |
| 夜图缺失                          | 日图（前端可叠加色调滤镜，属 C 的实现细节）            |
| 立绘非透明底（旧资产/模型不支持） | 卡片式呈现（带边框阴影浮层），不硬抠图                 |
| 增量生成进行中（60-180s）         | 先显示回退图，`plugin-data.changed`/媒体事件到位后替换 |
| 图像插件未启用                    | 全链路回退，纯文本 GalGame 布局照常可玩                |

回退是**默认行为不是错误态**：任何一层缺失都不弹错、不阻塞对话回合。

## §5 试点与验收

- 试点 haruka-academy：`--scaffold` → 人工润色 subject → `--dry-run` 审查 → 批量生成日/夜背景 + 重生成透明底立绘 → emit 注册表 → 世界导入后媒体库可解析全部 sceneId/characterId。
- 验收标准：新世界从零到有图的作者路径 ≤ 4 条命令（scaffold → 编辑 → dry-run → generate）；缺任意资产时按 §4 回退不报错。
- 文档：新增 `worlds/SCENES.md`（对照 PORTRAITS.md）；`docs/reference/world-data.md` 增补 scenes 媒体条目与注册表规则。
- 测试：脚本沿用 scripts/ 无套件惯例，靠 `--dry-run` 自校验；共享 lib 若含非平凡解析逻辑，加最小 vitest 用例。

## 决策记录

1. 清单为真 + 脚手架派生（作者可控，与 portraits 范式一致）。
2. 固定日/夜两张（GalGame 经典做法，用户选定）。
3. 运行时资产会话级为默认，玩家可显式提升到世界级（用户选定；实现归 C）。
4. 立绘透明底 tachi-e 为唯一生成规范，旧资产靠 UI 降级而非双规范（用户选定）。
5. 纯离线脚本方案，不做插件化管线（会话内等图不可接受）也不做 server 触发 API（YAGNI）。
