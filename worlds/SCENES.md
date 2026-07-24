# 场景背景 — 提示词文档（Scene Prompt Spec）

为世界生成舞台模式（stage mode）场景背景（教室、社团楼、海堤这类地点插画），日/夜各一张，接入 `scene-stage` 插件，存入各世界的 `media/`，**生成一次、长期复用**。

- 机器清单（脚本直接读）：`worlds/haruka-academy/media/scenes.json`
- 每张图的最终提示词 = `style.prefix` + 该场景 `subject`（夜图优先用 `subjectNight`，缺省回退 `subject`）+ `style.suffix`（+ 夜图追加 `style.nightSuffix`），`negative` 作为负向提示。
- 文件名规则：`<id>-day.png` / `<id>-night.png`，落在 `worlds/<world>/media/scenes/`。

## 作者工作流（四步）

```bash
# 1. 从 dimensions.yaml 的 regions 派生草稿清单（幂等，不覆盖已有条目）
npx tsx scripts/generate-scenes.mjs haruka-academy --scaffold
# 想连地标一起生成草稿：
npx tsx scripts/generate-scenes.mjs haruka-academy --scaffold --landmarks

# 2. 人工润色 worlds/<world>/media/scenes.json
#    - id 改成有意义的英文 slug（如 classroom-2b、library）
#    - subject 改写成英文画面描述：具体物件、光线、氛围、构图，禁止出现人物
#    - 场景合理的话补 subjectNight（如商店街夜晚的灯笼/霓虹）
#    - style 按世界气质微调，与该世界 portraits.json 的风格词汇对齐（同一世界背景和立绘是一套画风）

# 3. dry-run 审查 — 不出图、不联网，先审后花钱
npx tsx scripts/generate-scenes.mjs haruka-academy --dry-run

# 4. 确认无误后批量生成 + 生成注册表
npx tsx scripts/generate-scenes.mjs haruka-academy
node scripts/emit-scenes.mjs haruka-academy
```

`generate-scenes.mjs` 直接 import 框架 TS 源码（`packages/ai-provider/src/image/wire-registry.ts`），必须用 **tsx** 运行；`emit-scenes.mjs` 是纯 Node 脚本，`node` 直接跑即可。生成方式与 provider 接线（llm.toml slot / keys.env / image wire）与立绘完全同一套机制，不重复展开，见 [PORTRAITS.md](./PORTRAITS.md#生成方式框架统一-image-wire)。

## 日/夜两张与缺图回退

- 每个场景默认生成 `day` + `night` 两张（`--variant day|night` 只出一种）。
- 夜图的 subject 优先用 `scene.subjectNight`；留空则回退用 `scene.subject`（配合 `style.nightSuffix` 依然能得到偏暗色调的画面，但效果不如手写夜景描述）。
- `emit-scenes.mjs` 生成 `scenes.registry.json` 时：**缺 day 图的场景整条跳过**（不进注册表，day 是基准变体）；**缺 night 图记为 `night: null`**（运行时消费方回退用日图）。`scenes.registry.json` 是生成产物，**不要手编** — 重新生成场景图后必须重跑 `emit-scenes.mjs` 刷新哈希，否则注册表里的 sha256 与新图对不上。

## 参数表

| 参数                   | 说明                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `--scaffold`           | 从 `dimensions.yaml` 的 `geography.regions` 派生草稿清单，幂等、不覆盖已有 `locationRef`。 |
| `--landmarks`          | 配合 `--scaffold`，额外把每个 region 的 `landmarks` 也派生成草稿。                         |
| `--only id1,id2`       | 只处理指定场景 id。                                                                        |
| `--variant day\|night` | 只生成日图或夜图（默认两者都生成）。                                                       |
| `--size WxH`           | 覆盖 `defaults.size`（默认 `1536x1024`，横版构图）。                                       |
| `--quality q`          | 覆盖 `defaults.quality`。                                                                  |
| `--limit N`            | 只取清单前 N 个场景。                                                                      |
| `--concurrency N`      | 并发数（默认 5）。                                                                         |
| `--force`              | 覆盖已存在的文件（默认已存在的文件跳过）。                                                 |
| `--slot`               | 指定 `~/.covel/llm.toml` 的图像 slot（默认 `gpt-image-2`）。                               |
| `--dry-run`            | 只打印 prompt 队列，不出图、不联网。                                                       |

## 接入插件

`data/world.data.yaml` 里有两个相关 source：`scenes`（`kind: media, to: media, indexTo: plugin:scene-stage/assets, key: filename`）把 `media/scenes/*.png` 按 sha256 导入媒体库并写入 scene-stage 的 `assets` 索引；`scenesRegistry`（`kind: json, to: plugin:scene-stage/scenes, key: registryId`）把 `scenes.registry.json` 的 `sceneId → { day, night } MediaRef` 映射导入 scene-stage 的 `scenes` namespace，由 `scene-stage/resolver` 在 `scene.set` 事件到达时消费。

## 复用与重生成

- 图是内容资产，提交进各世界 `media/scenes/`，随世界包分发，下次开局直接用，不重复花钱。
- 想换风格：改 `scenes.json` 的 `style`，重跑脚本即可整组刷新。
- 想补/改单个场景：改其 `subject` / `subjectNight`，用 `--only <id> --force` 单独重跑。
