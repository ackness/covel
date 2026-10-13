# 给世界配场景图

这一页讲怎样给世界里的地点配上背景图：教室、码头、客栈大堂这一类。每个地点一张白天的图，可以再配一张夜晚的。它写给世界作者，不要求会编程，但要会运行命令、会编辑 JSON 文件。

做完之后，玩家在舞台视图下游玩时，故事走到哪个地点，背景就换成那个地点的图。图片只生成一次，以后每次开局直接使用。

流程和[给角色配立绘](./portraits.md)几乎一样：写清单、预览、出图、生成对应清单。先读过那一页会更顺。

## 开始之前

- 已经[从源码运行](../start/run-from-source.md)过 Covel，并运行过 `pnpm install --frozen-lockfile`。
- 世界文件夹放在仓库的 `worlds/` 目录下，例如 `worlds/tidelamp/`。脚本只认这个位置。
- 用脚本生成图片的话，需要一个图像模型和命令行工具 `cwebp`。两者的准备方法和立绘相同，见[给角色配立绘](./portraits.md#开始之前)。

下面的命令都在仓库的根目录运行。

> [!CAUTION]
> 生成图片会调用收费的图像服务。带 `--dry-run` 或 `--scaffold` 的命令不联网、不花钱。真正生成之前要先装好 `cwebp`；没有装时脚本会在要图之前报错停下，不会产生费用。

## 整个流程

| 步骤 | 你做什么                         | 得到什么                                                |
| ---- | -------------------------------- | ------------------------------------------------------- |
| 1    | 写场景清单，或者让脚本起一份草稿 | `media/scenes.json`                                     |
| 2    | 把每个场景的画面描述改好         | 改好的 `media/scenes.json`                              |
| 3    | 预览提示词，不出图               | 屏幕上的提示词                                          |
| 4    | 生成图片，或者放进自己做的图     | `media/scenes/` 里的 `<id>-day.webp`、`<id>-night.webp` |
| 5    | 生成“场景对应哪张图”的清单       | `media/scenes.registry.json`                            |
| 6    | 校验，然后开一局看效果           | 舞台视图里的背景                                        |

## 1. 得到一份场景清单

**世界在 `data/dimensions.yaml` 里写了地理（`geography` 下的 `regions`）时**，可以让脚本按地区起一份草稿：

```bash
pnpm exec tsx scripts/generate-scenes.mjs tidelamp --scaffold
```

```text
scaffolded 3 new scene draft(s) into worlds/tidelamp/media/scenes.json (3 total). Rename ids + polish subjects, then re-run with --dry-run.
```

想把每个地区下面的地标也各起一条，加上 `--landmarks`。这条命令可以重复运行：已经有的条目不会被覆盖，只会补上新的地点。

**世界没有写地理时**，这条命令会报 `no regions found …`。直接手写清单即可。新建 `worlds/tidelamp/media/scenes.json`：

```json
{
  "world": "tidelamp",
  "style": {
    "prefix": "Background art for a coastal mystery game, painterly semi-realistic scenery, cold sea-fog palette, no people, no characters, ",
    "suffix": ", clean wide establishing composition, calm lower third left clear for dialogue, consistent art style, no readable lettering",
    "negative": "people, character, figure, silhouette, text, caption, watermark, logo, frame",
    "nightSuffix": ", at night, deep blue ambient light, warm lamps and lit windows, readable midtones"
  },
  "defaults": { "size": "1536x1024", "quality": "medium" },
  "scenes": [
    {
      "id": "quay-inn",
      "name": "码头客栈",
      "locationRef": "码头客栈/客栈大堂",
      "subject": "Interior of a small harbour inn common room, low beams, a long scrubbed table, a brass storm lantern on the counter, fishing nets drying by a salt-stained window, grey daylight",
      "subjectNight": ""
    }
  ]
}
```

## 2. 把清单改好

| 字段                           | 意思                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `style.prefix`、`style.suffix` | 所有场景共用的画风描述。和这个世界立绘清单里的画风用词保持一致，背景和人物才像一套                                        |
| `style.negative`               | 所有场景共用的“不要出现”。场景图里不该有人                                                                                |
| `style.nightSuffix`            | 只加在夜图提示词最后的一段，用来描述夜晚的光                                                                              |
| `defaults.size`                | 图片尺寸，默认 `1536x1024`（横图）                                                                                        |
| `defaults.quality`             | 画质，默认 `medium`                                                                                                       |
| `scenes[].id`                  | 场景的名字，也是文件名的开头：图片叫 `<id>-day.webp` 和 `<id>-night.webp`。用有意义的英文短名，例如 `library`、`quay-inn` |
| `scenes[].name`                | 场景显示的名字                                                                                                            |
| `scenes[].locationRef`         | 这张背景对应故事里的哪些地点。一张图对应多个地点时用 `/` 分开，每一段都算这个场景的一个名字                               |
| `scenes[].subject`             | 白天的画面描述                                                                                                            |
| `scenes[].subjectNight`        | 夜晚专用的画面描述。留空时，夜图用 `subject`                                                                              |

脚本起的草稿有三处一定要改：

- `id` 是 `scene-01`、`scene-02` 这样的占位名，改成有意义的英文短名。
- `subject` 是从地理描述里原样抄来的。改写成英文的画面描述：具体的物件、光线、气氛、构图。不要出现人物。
- `style` 是一套通用的动漫背景画风。按你的世界改。

每张图的提示词是这样拼的：

- 日图：`style.prefix` + `subject` + `style.suffix`
- 夜图：`style.prefix` + `subjectNight`（没有就用 `subject`）+ `style.suffix` + `style.nightSuffix`

所以 `style.prefix` 里不要写“午后的阳光”这类只属于白天的话，否则会和夜图冲突。白天和夜晚的光分别写在 `subject` 和 `nightSuffix`（或 `subjectNight`）里。

### 名字决定背景会不会换

游戏不认识你的图画的是哪里。它是拿故事里报告的地点名，去和场景的名字比对的。一个场景的名字包括它的 `name` 和 `locationRef` 里的每一段。比对时不看空格和大小写，按下面的顺序，前一条没有结果才看后一条：

1. 地点名和场景的某个名字完全相同。
2. 地点名里包含某个名字。地点“图书馆二楼”能对上名字“图书馆”。有多个时取最长的那个名字。
3. 某个名字里包含地点名。地点“海堤”能对上名字“樱坂海堤”。但只有恰好一个场景如此时才算数。

所以两条经验：

- 名字要写成故事里会用的说法，和 `WORLD.md`、地理设定里的叫法一致。
- 不要让两个场景共用同一个短词。两个场景的名字里都有“走廊”时，地点“走廊”对不上任何一个，背景不会换。

没有对上任何场景时，舞台不换背景，这不算错误。

## 3. 预览，不出图

```bash
pnpm exec tsx scripts/generate-scenes.mjs tidelamp --dry-run
```

以内置的遥风学园为例，加上 `--limit 1` 只看第一个场景：

```bash
pnpm exec tsx scripts/generate-scenes.mjs haruka-academy --limit 1 --dry-run
```

```text
world=haruka-academy slot=gpt-image-2 size=1536x1024 quality=medium — 2 scene task(s) queued (dry-run, no network calls):

  classroom-2b [day] → classroom-2b-day.webp
    Visual novel background art, clean anime scenery style, …, no people, no characters, Interior of a bright Japanese high school classroom, …

    Avoid: people, character, figure, silhouette, text, caption, watermark, logo, frame, signature

  classroom-2b [night] → classroom-2b-night.webp
    Visual novel background art, clean anime scenery style, …, The approved seaside classroom after sunset, viewed from the same window-side aisle, …
```

一个场景有两项任务，日图和夜图各一项。`subject` 还是空的场景会被跳过，并提示你先把它写好。

## 4. 得到图片

### 用脚本生成

```bash
pnpm exec tsx scripts/generate-scenes.mjs tidelamp --slot image
```

`--slot` 后面写你在 `llm.toml` 里给图像模型起的用途名。不写时脚本找的是名为 `gpt-image-2` 的用途。脚本从哪里读模型配置和密钥，以及配置放在仓库根目录时该怎么运行，都和立绘脚本相同，见[脚本从哪里读模型配置和密钥](./portraits.md#生成方式框架统一-image-wire)。

图片存在 `worlds/tidelamp/media/scenes/`，每完成一张打印一行，最后是 `done: N ok, M failed`。已经存在的图会跳过，所以有失败时原样再运行一次，只会补缺的。

| 选项                   | 作用                                                 |
| ---------------------- | ---------------------------------------------------- |
| `--scaffold`           | 按 `data/dimensions.yaml` 里的地区起草清单。不出图   |
| `--landmarks`          | 和 `--scaffold` 一起用，把每个地区的地标也起草成场景 |
| `--dry-run`            | 只打印提示词，不联网，不出图                         |
| `--slot <名字>`        | 用 `llm.toml` 里的哪个用途。默认 `gpt-image-2`       |
| `--only <id>[,<id>]`   | 只处理这几个场景                                     |
| `--variant day\|night` | 只生成日图或只生成夜图。不写时两种都生成             |
| `--limit <N>`          | 只处理清单里的前 N 个场景                            |
| `--force`              | 覆盖已经存在的图                                     |
| `--size <宽x高>`       | 临时改尺寸，优先于 `defaults.size`                   |
| `--quality <画质>`     | 临时改画质，优先于 `defaults.quality`                |
| `--concurrency <N>`    | 同时生成几张，默认 5                                 |

常见的三种重做：

- 改一个场景：改它的 `subject`，然后 `--only quay-inn --force`。
- 只重做夜图：`--only quay-inn --variant night --force`。
- 整组换画风：改 `style`，然后 `--force`。

> [!WARNING]
> 脚本是按文字分别生成日图和夜图的，两张图互不参考。所以夜图的镜头、门窗、家具位置很可能和日图对不上，切换昼夜时背景会“跳”。在提示词里写“the same room”解决不了这个问题。
>
> 要让昼夜是同一个机位，先定稿日图，再用能“以图改图”的工具，以日图为参考只改光线，做出夜图，然后按下面的方法放进来。内置的遥风学园就是这样做的。脚本直接生成的夜图适合给新地点打草稿。

### 放进自己做的图

1. 把 PNG 放进 `worlds/tidelamp/media/scenes/`，命名为 `<id>-day.png` 或 `<id>-night.png`。
2. 转成 WebP：

   ```bash
   node scripts/encode-world-webp.mjs worlds/tidelamp/media/scenes/quay-inn-night.png
   ```

3. 删掉 PNG。留着的话，开局时两个文件都会被导入。

## 5. 生成场景与图片的对应清单

```bash
node scripts/emit-scenes.mjs tidelamp
```

```text
wrote worlds/tidelamp/media/scenes.registry.json with 1 scene(s)
```

`scenes.registry.json` 记录每个场景的日图和夜图各是哪个文件。它按图片内容算出的校验码来指认图片，所以不要手写，也不要手改。

缺图时的规则：

| 情况         | 结果                                                       |
| ------------ | ---------------------------------------------------------- |
| 场景没有日图 | 整个场景不写进清单，脚本最后列出被跳过的场景。日图是必需的 |
| 场景只有日图 | 写进清单，夜图记为空。游戏里到了夜晚仍然显示日图           |

> [!IMPORTANT]
> `media/scenes/` 里的任何一张图变了，都要重新运行这条命令。否则清单里记的是旧图的校验码，游戏里找不到图。

## 6. 让世界用上这些图

**世界没有 `data/world.data.yaml` 时，什么都不用做。** `media/scenes/` 和 `media/scenes.registry.json` 是约定好的位置，会被自动导入。

世界有 `data/world.data.yaml` 时，加上这两条，两条都不能少：

```yaml
sources:
  scenes:
    kind: media
    path: media/scenes
    to: media
    indexTo: contract:stage.scene-assets@1
    key: filename
  scenesRegistry:
    kind: json
    path: media/scenes.registry.json
    schema: contract:stage.scenes@1
    to: contract:stage.scenes@1
    key: registryId
    after: scenes
```

> [!NOTE]
> 这样写了之后，`media/scenes.registry.json` 这个文件必须存在，否则世界通不过校验。图还没做的时候，先运行一次 `node scripts/emit-scenes.mjs <世界ID>`：它会写出一份没有场景的空清单占位。出图后再运行一次即可。

**这一局要启用管理场景的插件。** 内置的是“场景舞台”（`scene-stage`），它包含在“对话模式”（`dialogue-mode`）玩法包里，“传统故事模式”里没有。把 `world.yaml` 的 `pluginPolicy.presetId` 改成 `dialogue-mode`，或者在开局的准备页展开“自定义插件与高级设置”选中它。

想让玩家一进游戏就是舞台视图，在 `world.yaml` 里加一行：

```yaml
defaultViewMode: stage
```

字段的完整说明见[世界数据参考的 Scene Backgrounds](../reference/world-data.md#scene-backgrounds)。

## 7. 校验并在游戏里查看

```bash
pnpm validate:world worlds/tidelamp
```

启动 Covel（`pnpm dev`），**新开一局**：

| 做什么                                     | 应该看到                                       |
| ------------------------------------------ | ---------------------------------------------- |
| 在世界列表和世界详情里看这个世界，开局之前 | 世界的图片里有这些场景图                       |
| 开局后切到“舞台”视图                       | 故事所在的地点有图时，背景是那张图             |
| 让故事换一个有图的地点                     | 背景跟着换。右侧面板的“场景”页签显示当前的场景 |
| 让故事到夜晚                               | 有夜图的场景换成夜图，没有的保持日图           |

图片是在创建一局游戏时导入的，改图之后要新开一局才能看到。

检查图片本身时，注意这几样：下方放对话框的区域和人物站立的区域是否干净、夜图的中间亮度够不够看清、日夜两张的机位是否一致、图里有没有乱码的招牌文字。

## 不是每个世界都适合“白天和夜晚”

日夜两张图是为有昼夜作息的世界设计的，例如校园。别的世界照搬会很别扭：

- 一个永远起雾的港口，更值得区分的是涨潮和退潮。
- 一颗一面永远朝向太阳的行星，没有昼夜，值得区分的是风暴、断电这类状态。

目前清单只有“日”和“夜”两个位置。这类世界可以只做日图。每个内置世界的取舍见[世界美术方向](./art-direction.md)。

## 没有按预期工作时

| 现象                                                                                  | 原因和处理                                                                                                            |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--scaffold` 报 `no regions found in …/dimensions.yaml`                               | 世界的地理设定里没有地区列表。手写 `media/scenes.json`                                                                |
| 预览时提示 `… has an empty subject — polish scenes.json first, skip`                  | 这个场景的 `subject` 是空的。写好再运行                                                                               |
| `--variant must be one of: day\|night`                                                | `--variant` 后面只能写 `day` 或 `night`                                                                               |
| `Slot [covel.gpt-image-2] missing in …`、`No API key. …`、`cwebp is not installed; …` | 模型配置、密钥或 `cwebp` 的问题，处理方法见[立绘页的故障表](./portraits.md#没有按预期工作时)                          |
| `emit-scenes` 提示 `missing day image, skipped: …`                                    | 这些场景没有日图，没有写进清单。补上 `<id>-day.webp` 再运行一次                                                       |
| 校验报找不到 `media/scenes.registry.json`                                             | `data/world.data.yaml` 里登记了它，但文件还不存在。运行一次 `emit-scenes`                                             |
| 游戏里背景一直不换                                                                    | 依次检查：是不是新开的一局；有没有启用“场景舞台”；是不是在“舞台”视图；故事里的地点名能不能对上场景的名字（见第 2 步） |
| 背景换错了地方                                                                        | 两个场景的名字互相包含，或者共用了一个短词。把 `locationRef` 写得更具体                                               |
| 昼夜切换时画面跳了一下                                                                | 日图和夜图是分别生成的，机位不同。以日图为参考重做夜图                                                                |
| 改了图，游戏里还是旧图或没有图                                                        | 没有重新运行 `emit-scenes`，或者看的是改图之前开的那一局                                                              |

## 接下来

- **给角色配立绘。** 见[给角色配立绘](./portraits.md)。
- **定下整个世界的画风，知道交付前检查什么。** 见[世界美术方向](./art-direction.md)。
- **给世界配背景音乐。** 见[世界数据参考的 Background Music](../reference/world-data.md#background-music)。
