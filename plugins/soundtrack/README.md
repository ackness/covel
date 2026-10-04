# soundtrack

播放世界自带的背景音乐，并跟随当前场景和故事的情绪切换曲目。它只决定「现在该放哪一首」，把结果投影到内核槽位 `stage.music@1`；播放、淡入淡出、音量和静音由应用负责。

## 运行时结构

- `PLUGIN.md`：插件级元信息、`music.cue` 事件、两个数据契约和 `stage.music@1` 槽位提供者的声明。
- `server/index.js`：`stage.music@1` 的提供者。每次投影时用「情绪 + 场景 + 曲目表」算出曲目，再按文件名从 `assets` 里取出音频的 `MediaRef`。
- `runtimes/cue/`：事件触发函数 runtime（消费 `music.cue`），只把情绪写入 `state/mood`。
- `runtimes/scene/`：事件触发函数 runtime（消费 `scene.set`），只把场景名写入 `state/scene`。
- `lib/soundtrack.js`：namespace / key 常量和唯一的选曲规则 `selectTrack`。
- `schemas/`：`music.cue` 载荷、曲目表和音乐文件索引的校验。

两个 runtime 各写自己的 key，不读对方的数据，所以同一回合里既换场景又换情绪也不会互相覆盖。曲目不落库：相同的情绪、场景和曲目表总是算出同一首，刷新或恢复会话后回到同一段音乐。

## 选曲规则

曲目表里靠前的曲目优先。按顺序取第一条命中的规则：

1. 既符合当前情绪、又属于当前场景的曲目；
2. 符合当前情绪、不限场景的曲目；
3. 当前场景自己的曲目（没有声明情绪的）；
4. 世界主题曲（`theme: true`）；
5. 静音。

情绪为 `silence` 时直接静音。场景名按「相同，或一方包含另一方」匹配，与场景背景的匹配方式一致。

## 世界包怎么提供音乐

把音乐文件放进 `media/music/`（`.mp3` 或 `.wav`），再写一份曲目表 `media/music.yaml`：

```yaml
schemaVersion: 1
registryId: music-registry
tracks:
  - id: battle
    file: battle.mp3
    moods: [battle, tense]
    volume: 0.8
  - id: tavern
    title: 歪角鹿酒馆
    file: tavern.mp3
    scenes: [歪角鹿酒馆]
  - id: theme
    title: 提灯古冢
    file: theme.mp3
    theme: true
```

没有 `worldData` 描述符的世界按这两个约定路径自动导入。有描述符的世界加两个来源：

```yaml
music:
  kind: media
  path: media/music
  to: media
  indexTo: contract:stage.music-assets@1
  key: filename
musicTracks:
  kind: yaml
  path: media/music.yaml
  to: contract:stage.music-tracks@1
  key: registryId
  after: music
```

`file` 写文件名即可，不需要手写哈希：导入时每个文件在 `assets` 里生成一条以文件名为 key 的索引记录。可用的情绪：`calm`、`warm`、`joy`、`romance`、`sorrow`、`mystery`、`tense`、`dread`、`battle`、`triumph`。

## 事件

- `music.cue`（本插件声明）：叙事在情绪明显变化时发射，载荷 `{ mood }`。每回合最多一次，情绪没变不发。
- `scene.set`（由跟踪场景的插件声明）：本插件只订阅。会话里没有这样的插件时这个事件不会出现，曲目就只按情绪和主题曲选。

两个事件都参与同回合预览：槽位提供者声明了 `preview`，音乐在回合提交前就会跟着切换。

## 开发

修改选曲规则、事件载荷或槽位输出后，运行本插件测试：

```bash
pnpm --filter @covel/plugin-soundtrack test
```
