# 给角色配立绘

这一页讲怎样给世界里的角色配上头像和立绘。它写给世界作者，不要求会编程，但要会在命令行里运行命令、会编辑 JSON 文件。

做完之后，你的世界包里会多出一组角色图片和一份清单。玩家开局后，这些图片显示在右侧的“角色立绘”面板里；在舞台视图下，它们就是站在场景前的立绘。图片只需要生成一次，以后每次开局直接使用，不再花钱。

图片可以用脚本调用图像模型生成，也可以是你自己画的、或用别的工具做好的。两种来源的后半段流程相同。

## 开始之前

- 已经[从源码运行](../start/run-from-source.md)过 Covel。脚本都在仓库里。
- 有一个能通过校验的世界，见[第一个世界](./first-world.md)。
- **世界文件夹要放在仓库的 `worlds/` 目录下**，例如 `worlds/tidelamp/`。这几个脚本只认这个位置。你的世界在 `~/.covel/worlds/` 里时，先把整个文件夹移过来，做完图再移回去。不要两边各留一份，同一个 ID 的世界不能有两个。
- 用脚本生成图片的话，还需要：
  - 一个图像模型。在 `llm.toml` 里它是一个用途，例如 `[covel.image]`，见[模型用途参考](../reference/slots.md)。
  - 命令行工具 `cwebp`，用来把图片压成 WebP。macOS 上运行 `brew install webp`，Debian 或 Ubuntu 上运行 `apt install webp`。

下面的命令都在仓库的根目录运行，例子里的世界 ID 是 `tidelamp`。

> [!CAUTION]
> 生成图片会调用收费的图像服务。这一页里凡是带 `--dry-run` 的命令都不联网、不花钱；去掉它才会真正出图。
>
> 生成之前要先装好 `cwebp`。脚本会在向服务要图之前检查它：没有装时直接报错停下，不会产生费用。

## 整个流程

| 步骤 | 你做什么                         | 得到什么                                  |
| ---- | -------------------------------- | ----------------------------------------- |
| 1    | 写一份清单，说明每个角色长什么样 | `media/portraits.json`                    |
| 2    | 预览提示词，不出图               | 屏幕上的提示词                            |
| 3    | 生成图片，或者放进自己做的图     | `media/portraits/` 里每个角色一张 `.webp` |
| 4    | 生成“角色对应哪张图”的清单       | `media/presence.json`                     |
| 5    | 校验，然后开一局看效果           | 游戏里的立绘                              |

## 1. 写立绘清单

新建 `worlds/tidelamp/media/portraits.json`：

```json
{
  "world": "tidelamp",
  "style": {
    "background": "transparent",
    "prefix": "Full-body character art for a coastal mystery tabletop game, painterly semi-realistic style, cold sea-fog palette with warm lamp light, vertical 2:3 framing, isolated character on a transparent background, ",
    "suffix": ", consistent art style, clear silhouette, complete feet with a little empty space below",
    "negative": "text, caption, watermark, logo, frame, multiple people, extra fingers, deformed hands, background scenery"
  },
  "defaults": { "size": "1024x1536", "quality": "medium" },
  "characters": [
    {
      "id": "he-sanniang",
      "characterId": "npc-he-sanniang",
      "name": "何三娘",
      "filename": "he-sanniang.webp",
      "subject": "a sturdy innkeeper in her early fifties, greying hair pinned up, plain indigo apron over a quilted jacket, holding a brass storm lantern, a level unhurried gaze"
    }
  ]
}
```

每张图的提示词由三段拼成：`style.prefix` + 这个角色的 `subject` + `style.suffix`。`negative` 写不想要的东西，会作为“Avoid: …”附在最后。

| 字段                           | 意思                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `style.prefix`、`style.suffix` | 所有角色共用的画风描述。画风统一靠的就是这两段：只在这里写画法、色调、取景                                   |
| `style.negative`               | 所有角色共用的“不要出现”                                                                                     |
| `style.background`             | 写 `"transparent"` 表示要透明背景。脚本会检查每张图确实带透明通道。不想要透明背景就不写这一项                |
| `defaults.size`                | 图片尺寸，默认 `1024x1536`（竖图）                                                                           |
| `defaults.quality`             | 画质，默认 `medium`                                                                                          |
| `characters[].id`              | 这张图在清单里的名字，重新生成单个角色时用                                                                   |
| `characters[].characterId`     | **游戏里这个角色的 ID。** 必须和 `characters/characters.json` 里那个角色的 `id` 完全相同，否则图配不到人身上 |
| `characters[].name`            | 显示的名字                                                                                                   |
| `characters[].filename`        | 存成什么文件名。用 `.webp` 结尾                                                                              |
| `characters[].subject`         | 只属于这个角色的描述：年龄、体型、发型、衣着、手里的东西、神情                                               |

写 `subject` 的几条经验：

- 用英文写，图像模型对英文的理解更稳。
- 把这个角色区别于别人的东西写出来：一件标志性的道具、一种神情、一处世界观细节。
- 年龄和身份以角色文件里的记录为准。没有设定的长相和衣着细节属于画面表达，不要反过来当成新的设定写回世界里。

> [!NOTE]
> `characterId` 就是角色在 `characters/characters.json` 里的 `id`，原样照抄，不加也不去掉前缀。

### 同一个角色的不同表情和服装

给角色加 `variants`，每一项是另一张图：

```json
{
  "id": "he-sanniang",
  "characterId": "npc-he-sanniang",
  "name": "何三娘",
  "filename": "he-sanniang.webp",
  "subject": "a sturdy innkeeper in her early fifties, …",
  "visual": {
    "id": "apron-calm",
    "outfit": "apron",
    "expression": "calm",
    "pose": "default"
  },
  "variants": [
    {
      "id": "apron-alarmed",
      "filename": "he-sanniang-apron-alarmed.webp",
      "outfit": "apron",
      "expression": "alarmed",
      "pose": "default",
      "subject": "the same sturdy innkeeper in her early fifties, …, eyes wide, lantern raised"
    }
  ]
}
```

- `visual` 说明默认那张图是什么服装、表情和姿势。不写时是 `default` / `neutral` / `default`。
- 每个变体要有自己的 `id` 和 `filename`。`subject` 不写时沿用角色的 `subject`。
- 故事要用一个还没画的表情时，舞台会退回到默认的那张图，不会空着。

> [!WARNING]
> 脚本是按文字单独生成每一张图的，不会参考已有的图。所以变体里写“the same …”并不能保证是同一张脸。要让变体和原图是同一个人，应该用能“以图改图”的工具，把定稿的那张图作为参考来改，然后按第 3 步的“放进自己做的图”处理。

## 2. 预览，不出图

```bash
pnpm exec tsx scripts/generate-portraits.mjs tidelamp --dry-run
```

它打印每张图的文件名和完整提示词，然后结束。以内置的遥风学园为例，加上 `--limit 1` 只看第一张：

```bash
pnpm exec tsx scripts/generate-portraits.mjs haruka-academy --limit 1 --dry-run
```

```text
world=haruka-academy slot=gpt-image-2 size=1024x1536 quality=medium — 1 portrait(s) queued (dry-run, no network calls):

  kamishiro-mio → kamishiro-mio.webp
    Character sprite for a visual novel, clean anime style, soft cel-shading, crisp lineart, …, a gentle reserved seventeen-year-old girl, the class representative and literature-club president, …

    Avoid: photorealistic, realism, 3d render, dark, gritty, horror, …
```

逐条读一遍提示词。在这一步改清单不花钱。

`--dry-run` 不检查模型配置和密钥，所以预览通过不代表第 3 步一定能连上服务。

## 3. 得到图片

### 用脚本生成

```bash
pnpm exec tsx scripts/generate-portraits.mjs tidelamp --slot image
```

`--slot` 后面写你在 `llm.toml` 里给图像模型起的用途名。不写时脚本找的是名为 `gpt-image-2` 的用途，你的配置里多半没有这个名字，所以总是把它写上。

脚本同时生成多张（默认 5 张一起），每完成一张打印一行，最后打印汇总：

```text
world=tidelamp slot=image (provider=openai, wire=openai-images) model=… size=1024x1536 quality=medium concurrency=5
generating 1 portrait(s) concurrently → worlds/tidelamp/media/portraits/

  ✅ 何三娘 (he-sanniang.webp) 141 KB · 38.2s

done: 1 ok, 0 failed
```

图片存在 `worlds/tidelamp/media/portraits/`。

- **已经存在的图会跳过。** 所以有几张失败时，原样再运行一次命令，只会补缺的那几张。
- **不满意就单独重画。** 改这个角色的 `subject`，然后运行 `--only he-sanniang --force`。
- **想整组换画风。** 改 `style`，然后加 `--force` 全部重画。

<a id="生成方式框架统一-image-wire"></a>

#### 脚本从哪里读模型配置和密钥

| 读什么   | 从哪里读                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 模型配置 | 环境变量 `COVEL_LLM_TOML` 指向的文件。没有设置时读 `~/.covel/llm.toml`                                                            |
| 密钥     | 按顺序找，用第一个找到的：环境变量 `COVEL_IMG_KEY`；环境变量 `<服务商>_API_KEY`；`~/.covel/keys.env` 里的同名项；`OPENAI_API_KEY` |

也就是说，默认用的是桌面版那一套配置（`~/.covel/` 下的文件）。脚本不会自己去读仓库根目录的 `llm.toml`、`.env` 和 `.env.llm`。你的配置在仓库根目录时，这样运行：

```bash
COVEL_LLM_TOML=llm.toml pnpm exec tsx \
  --env-file-if-exists=.env --env-file-if-exists=.env.llm \
  scripts/generate-portraits.mjs tidelamp --slot image --dry-run
```

确认无误后去掉 `--dry-run`。

脚本里没有写死任何服务地址。换一家图像服务只需要改 `llm.toml` 和密钥。用途里的 `providerRequestMetadata.imageWire` 决定用哪种接口格式，不写时是 `openai-images`。

#### 全部选项

| 选项                 | 作用                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------- |
| `--dry-run`          | 只打印提示词，不联网，不出图                                                            |
| `--slot <名字>`      | 用 `llm.toml` 里的哪个用途。默认 `gpt-image-2`                                          |
| `--only <id>[,<id>]` | 只处理这几个角色。写角色的 `id` 会包含它的全部变体；写 `角色id:变体id` 只处理那一个变体 |
| `--limit <N>`        | 只处理清单里的前 N 张                                                                   |
| `--force`            | 覆盖已经存在的图                                                                        |
| `--size <宽x高>`     | 临时改尺寸，优先于 `defaults.size`                                                      |
| `--quality <画质>`   | 临时改画质，优先于 `defaults.quality`                                                   |
| `--concurrency <N>`  | 同时生成几张，默认 5                                                                    |
| `--model <模型名>`   | 临时换一个模型，优先于用途里配置的模型                                                  |
| `--chroma`           | 给不支持透明背景的服务用：改为画在纯绿色的底上，并存成 `.png`。见下面的说明             |

**服务不支持透明背景时。** 加上 `--chroma`，脚本不再要求透明背景，而是让模型把人物画在纯绿（`#00FF00`）的底上，图片以 `.png` 存在目标文件旁边。接下来你用图像编辑工具把绿底去掉，再按下面“放进自己做的图”的方法转成 WebP。

### 放进自己做的图

自己画的图、用别的工具生成或修改的图，都可以直接用：

1. 把 PNG 放进 `worlds/tidelamp/media/portraits/`，文件名和清单里的 `filename` 对应，只是扩展名是 `.png`。
2. 转成 WebP：

   ```bash
   node scripts/encode-world-webp.mjs worlds/tidelamp/media/portraits/he-sanniang.png
   ```

   它在旁边写出同名的 `.webp`，并打印前后的大小。可以一次给多个文件。

3. **删掉 PNG。** 留着的话，开局时两个文件都会被当作立绘导入。

对图片的要求：

- 尺寸和清单的 `defaults.size` 完全一致（默认 `1024x1536`）。
- 清单写了 `"background": "transparent"` 时，图片必须真的有透明的像素。只是带一个全不透明的透明通道不算，把棋盘格画进图里更不行。
- 图里不要有说明文字、水印。

即使图不是脚本生成的，清单 `portraits.json` 仍然要写：下一步靠它知道哪张图属于哪个角色。

## 4. 生成角色与图片的对应清单

```bash
node scripts/emit-presence.mjs tidelamp
```

```text
wrote worlds/tidelamp/media/presence.json with 1 presence record(s)
```

`presence.json` 记录每个角色用哪张图。它不是按文件名、而是按图片内容算出的一串校验码来指认图片的，所以这个文件不要手写，也不要手改。

> [!IMPORTANT]
> 只要 `media/portraits/` 里的任何一张图变了（重新生成、重新压缩、替换），就要重新运行这条命令。否则清单里记的还是旧图的校验码，游戏里就找不到图。

如果有图还没做出来，脚本会跳过那些角色，并在最后列出缺少的文件名。

世界有第二种语言时，译名写在 `media/presence.<语言>.json` 里，每一项只有 `characterId` 和 `displayName`。这个文件不含图片信息，重新生成图片后不用动它。写法见[世界数据参考的语言文件](../reference/world-data.md#语言文件namelocaleext)。

## 5. 让世界用上这些图

**什么都不用登记。** `media/portraits/` 和 `media/presence.json` 是约定好的位置，上面的脚本也只写这两处。放在那里的图片和清单会被自动导入：图片存进这一局的媒体库，清单告诉游戏哪个角色用哪张图。世界有 `data/world.data.yaml` 时也一样，那个文件只写和约定不同的地方。格式和放在别处时的写法见[世界数据参考](../reference/world-data.md#character-presence-portraits)。

**这一局要启用显示立绘的插件。** 内置的是“角色资料”（`character-blueprint`）。它包含在“对话模式”（`dialogue-mode`）这个玩法包里；“传统故事模式”（`traditional-story`）里没有它。两种办法任选：

- 在 `world.yaml` 的 `pluginPolicy.plus` 里加上 `character-blueprint`，或者把 `pluginPolicy.preset` 改成 `dialogue-mode`。
- 或者在开局的准备页展开“自定义插件与高级设置”，选中“角色资料”。

没有启用时，图片和对应清单会被跳过，开局时给出一条提醒。

## 6. 校验并在游戏里查看

```bash
pnpm validate:world worlds/tidelamp
```

然后启动 Covel（`pnpm dev`），在世界列表里找到你的世界：

| 在哪里看                                   | 应该看到                     |
| ------------------------------------------ | ---------------------------- |
| 世界列表和世界详情，开局之前               | 世界的图片里有这些立绘       |
| **新开一局**之后，右侧面板的“角色立绘”页签 | 每个角色的立绘。点击可以放大 |
| 切到“舞台”视图，等这个角色出场             | 角色的立绘站在场景前         |

图片是在创建一局游戏时导入的。改了图之后要新开一局才能看到，已经开始的那一局不会变。

检查图片本身时，看这几样：原尺寸下的细节、缩小成头像时还认不认得出、分别放在浅色和深色的底上、手机宽度下被裁掉了什么。

## 没有按预期工作时

| 现象                                                         | 原因和处理                                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 运行脚本时报找不到 `worlds/<id>/media/portraits.json`        | 世界不在仓库的 `worlds/` 目录下，或者清单的位置、文件名不对                                                                          |
| `Slot [covel.gpt-image-2] missing in …/llm.toml`             | 没有写 `--slot`，或者写的用途名在这份 `llm.toml` 里不存在。提示里的路径就是脚本实际读的那个文件                                      |
| `No API key. Set …_API_KEY in the environment or …/keys.env` | 找不到密钥。按“脚本从哪里读模型配置和密钥”设置其中一处                                                                               |
| `Unknown image wire "…"`                                     | 用途里的 `providerRequestMetadata.imageWire` 写错了                                                                                  |
| `cwebp is not installed; install libwebp`                    | 没有装 `cwebp`。脚本在要图之前就停下了，没有产生费用。装好后重新运行                                                                 |
| `… has no PNG alpha channel; expected transparency`          | 清单要求透明背景，但服务返回的图不透明。换一个支持透明背景的模型（`--model`），或者改用 `--chroma`                                   |
| `… has 1024x1024; expected 1024x1536`                        | 图片尺寸和清单的 `defaults.size` 不一致。生成时是服务没有按要求的尺寸出图；自己做的图要改成清单里的尺寸                              |
| 最后一行是 `done: 3 ok, 2 failed`                            | 有几张失败了，原因在各自那一行。原样再运行一次，只会重试失败的                                                                       |
| `emit-presence` 提示 `missing portraits, skipped: …`         | 这些图还不在 `media/portraits/` 里，对应的角色没有写进清单。补上图后再运行一次                                                       |
| 游戏里角色没有立绘                                           | 依次检查：是不是新开的一局；这一局有没有启用“角色资料”；`characterId` 和角色的 ID 是否完全相同；改图后有没有重新运行 `emit-presence` |
| 世界的图片里同一张立绘出现了两次                             | `media/portraits/` 里同时留着 `.png` 和 `.webp`，两个都被导入了。删掉 PNG                                                            |

## 图片做好之后

- 立绘是世界内容的一部分，随世界包一起发给别人。仓库里只收 WebP：`media/portraits/` 下的 PNG 被 Git 忽略，只是你本地的工作文件。
- 已经压过一次的 WebP 不要再压一次，画质会继续变差。要改图时，从没有压缩过的原图重新转。

<a id="三套风格方向"></a>

## 内置世界是怎么做的

四个内置世界各有自己的画风，可以打开它们的清单当例子看：

| 世界                      | 清单                                                                 | 画风                                         | 取景                         | 人数 |
| ------------------------- | -------------------------------------------------------------------- | -------------------------------------------- | ---------------------------- | ---- |
| 遥风学园 `haruka-academy` | [`portraits.json`](../../worlds/haruka-academy/media/portraits.json) | 动漫视觉小说立绘，柔和的赛璐珞上色，春日粉彩 | 竖图，头到大腿，透明背景     | 8    |
| 雾港 `mistport`           | [`portraits.json`](../../worlds/mistport/media/portraits.json)       | 写实绘画感的雾中 noir，冷灰、青、锈色        | 半身像，四分之三侧，灰雾背景 | 7    |
| Emberback `emberback`     | [`portraits.json`](../../worlds/emberback/media/portraits.json)      | 明亮的复古科幻冒险海报，奶油、陶土、钴蓝     | 全身，带各自职业的环境       | 5    |
| 提灯古冢 `lantern-barrow` | [`portraits.json`](../../worlds/lantern-barrow/media/portraits.json) | 写实的皮肤和旧衣料，暖色主光加冷色轮廓光     | 竖图，全身，透明背景         | 6    |

值得学的两点：

- 雾港把世界观细节写进了每个人的 `subject`：手腕上的潮纹、半透明的左臂、把玩着的遗物碎片。立绘因此自带设定。
- Emberback 的人物带着各自的工作环境（维修间、车站坪、观测台），而不是透明背景。透明背景适合舞台视图，带环境的人物卡适合传统的文字叙事。按你的世界怎么玩来选。

每个世界应该传达什么、哪些地方不能画错，见[世界美术方向](./art-direction.md)。

## 接下来

- **给地点配背景图。** 见[给世界配场景图](./scenes.md)。
- **定下整个世界的画风，知道交付前检查什么。** 见[世界美术方向](./art-direction.md)。
- **让图片出现在世界列表和世界详情里，并配上介绍。** 见[画廊资料](./art-direction.md#画廊资料与前端使用)。
