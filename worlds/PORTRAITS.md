# 角色立绘 — 提示词文档（Portrait Prompt Spec）

为两个旗舰世界的角色生成**统一风格**的立绘 / 头像，接入 `character-presence` 插件，存入各世界的 `media/`，**生成一次、长期复用**。

- 机器清单（脚本直接读）：`worlds/mistport/media/portraits.json` · `worlds/haruka-academy/media/portraits.json`
- 每张图的最终提示词 = `style.prefix` + 该角色 `subject` + `style.suffix`（共享前后缀保证**整组同风格**），`negative` 作为负向提示。
- 文件名对应角色卡的 `instantiate.characterId`：文件 `<id>.png` → 角色 `npc-<id>`（见清单 `characterId`）。

## 两套风格方向

| 世界                        | 题材          | 统一风格                                                                        | 取景 / 画幅                |
| --------------------------- | ------------- | ------------------------------------------------------------------------------- | -------------------------- |
| **mistport** 雾港·裂潮纪    | 黑暗奇幻·悬疑 | fog-noir 写实绘画感、冷灰/青/锈的去饱和、海雾体积光、低调戏剧打光、哥特港口氛围 | 半身胸像、3/4 侧、灰雾背景 |
| **haruka-academy** 遥风学园 | 校园恋爱·日常 | 动漫视觉小说立绘（GalGame 拔模/tachi-e）、柔和赛璐珞、春日粉彩、暖光、海边校园  | 半身胸像、柔和渐变背景     |

> 两套**刻意不同**——一冷一暖、一写实一动漫——这样两个世界各自成体系，也直观传达"故事 vs 对话"两种玩法。每个世界**内部**则严格同风格（靠共享 prefix/suffix）。

## 角色清单

**mistport（7）**：林远舟（学徒·腕有潮纹）· 苏窈（验潮师·鉴定镜）· 铁姑（盐牙·左臂雾蚀半透明）· 陈远山（议长·把玩遗物碎片）· 齐老（公会长·指尖雾蚀·潮汐笔记）· 小霜（雾使·侧耳倾听）· 灰隼（执法队长·遮罩提灯）。每张的世界细节（潮纹、雾蚀、遗物碎片）都写进了 `subject`，让立绘自带世界观。

**haruka-academy（8）**：神代澪（班长/文艺部）· 朝仓凛（新闻部·采访本相机）· 椎名夏帆（轻音部·吉他）· 白石悠真（学生会副会长·眼镜文件夹）· 三枝遥（学生会长·日程本）· 小野寺千寻（班主任·粉笔旧书）· 森川奏太（鼓手·鼓棒）· 东条茜（图书委员·夹干花的书）。全部 teen 尺度、清爽。

## 生成方式（参考 openai-image-gen 的调用）

调用 = 标准 **OpenAI Images API**：`POST {baseUrl}/v1/images/generations`，`Authorization: Bearer <key>`，body `{ model, prompt, n, size, quality }`（与 `openai-image-gen` 插件同一套 wire）。**脚本不硬编码任何服务地址**——`baseUrl`/`model`/`provider` 从 `~/.covel/llm.toml` 的指定 slot 读取，key 从 `~/.covel/keys.env` 按 `<PROVIDER>_API_KEY` 约定读取。换服务只改 llm.toml，不动脚本。

生成脚本 `scripts/generate-portraits.mjs`（**并发**批量）：

```bash
# 并发生成某世界全部立绘（默认 slot gpt-image-2，并发 5；已存在的跳过）
node scripts/generate-portraits.mjs mistport
node scripts/generate-portraits.mjs haruka-academy
# 指定 slot / 并发数 / 只重跑某角色 / 覆盖
node scripts/generate-portraits.mjs mistport --slot gpt-image-2 --concurrency 6 --only iron-meg --force
```

流程：读该世界 `portraits.json` → 逐角色合成 `prefix+subject+suffix` → **并发** POST → PNG 存到 `worlds/<world>/media/portraits/<filename>`。已存在文件默认跳过，失败直接重跑（只补缺的）。

默认参数（可在 `portraits.json` 的 `defaults` 调）：`size 1024x1536`（竖构图立绘）、`quality medium`、`png`。

## 接入 character-presence（已接线）

展示立绘的插件就是 **`character-presence`**：右侧角色面板显示头像，对话模式下作为 GalGame 立绘。两个世界的 `data/world.data.yaml` 已加好两条 source：

- `media` source：导入 `media/portraits/` 下的图，按 **sha256 内容寻址**存入媒体库，`to: media` + `indexTo: plugin:character-presence/assets`；
- `presence` source（`media/presence.json`）：把 `characterId: npc-<id>` 的 `avatar` / `sprite` 指向上面导入的媒体（`mediaRef.id` = 该图的 sha256）。

`presence.json` 由 `scripts/emit-presence.mjs <world>` 从 `portraits/` 目录按 sha256 自动生成：

```bash
node scripts/emit-presence.mjs mistport
node scripts/emit-presence.mjs haruka-academy
```

> ⚠️ **重生成立绘后必须重跑 `emit-presence` 刷新哈希**，否则 presence 的 `avatar.id` 与新图对不上。

两个世界都已把 `character-presence` 列入 `recommendedPlugins`，session 创建即自动导入、开局右侧面板与对话立绘直接显示。立绘 PNG 通过 `.gitignore` 负向规则 `!worlds/**/media/portraits/*.png` 纳入版本库，随世界包分发。

## 复用与重生成

- 图是内容资产，提交进各世界 `media/portraits/`，随世界包分发，**下次开局直接用**，不重复花钱。
- 想换风格：改 `portraits.json` 的 `style`，重跑脚本即可整组刷新。
- 想补/改单个角色：改其 `subject`，单独重跑该 `id`。
