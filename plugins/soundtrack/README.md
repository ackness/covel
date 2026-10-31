# soundtrack

播放世界自带的背景音乐，并跟随当前场景和故事的情绪切换曲目。它只决定「现在该放哪一首」，把结果投影到内核槽位 `stage.music@1`；播放、淡入淡出、音量和静音由应用负责。

## 运行时结构

- `PLUGIN.md`：插件级元信息、`music.cue` 事件、两个数据契约和 `stage.music@1` 槽位提供者的声明。
- `server/index.js`：`stage.music@1` 的提供者。每次投影时用「情绪 + 场景 + 曲目表」算出曲目，再按文件名从 `assets` 里取出音频的 `MediaRef`。同一个文件还提供 `prompt.segment@1`：把这个世界有哪些音乐情绪、各在什么时候适用告诉叙事。
- `runtimes/cue/`：事件触发函数 runtime（消费 `music.cue`），只把情绪写入 `state/mood`。
- `runtimes/scene/`：事件触发函数 runtime（消费 `scene.set`），只把场景名写入 `state/scene`。
- `runtimes/story-cues/`：`post-turn` 函数 runtime，可选读取 `narrative-engine@2` 完整故事的 `ctx.inputs.story.value`；把已知 `cues.mood` 和去掉首尾空白的 `cues.scene` 写入各自的 `state` key，不强制启用叙事插件。
- `lib/soundtrack.js`：namespace / key 常量和唯一的选曲规则 `selectTrack`。
- `schemas/`：`music.cue` 载荷、曲目表和音乐文件索引的校验。

情绪与场景各写自己的 key，所以同一回合里既换场景又换情绪也不会互相覆盖。故事提示的更新与故事在同一次执行中提交，没有提交前预览；槽位在提交后按 namespace 更新。曲目不落库：相同的情绪、场景和曲目表总是算出同一首，刷新或恢复会话后回到同一段音乐。

故事情绪按忽略大小写和空白的方式匹配世界的情绪清单，写入世界使用的原名；`silence` 始终可用。未知情绪保留当前值，并记录原因，不会重置音乐；同一次故事里的场景仍会更新。缺少故事、没有相关提示、情绪与场景没有变化或世界没有曲目表时，成功跳过并记录原因。`state/*` 形状不变，无需重建现有会话数据。

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

`scenes` 按名字匹配当前场景：名字相同，或一个名字包含在另一个里（忽略大小写和空白）。所以太短的名字（例如单个“港”字）会匹配到所有带这个字的地点，请写完整的场景名。

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

`file` 写文件名即可，不需要手写哈希：导入时每个文件在 `assets` 里生成一条以文件名为 key 的索引记录。

情绪的名字由世界作者自己定，插件不预设任何一个。曲目表顶层的 `moods` 说明每种情绪什么时候适用，叙事只会看到这里写的名字和说明：

```yaml
moods:
  - id: battle
    when: 刀已出鞘，胜负未分。
  - id: 灯下
    when: 回到有灯有火的地方，暂时安全。
```

没写顶层 `moods` 时，情绪清单就是各曲目 `moods` 里出现过的名字，没有说明。所有曲目都没有 `moods` 的世界没有情绪清单，音乐只跟随场景和主题曲；仍可用 `silence` 停止音乐。匹配时不区分大小写和空白。

## 事件

- `music.cue`（本插件声明）：分段故事优先写 `cues.mood`；不以段落作答的故事在情绪明显变成世界列出的某一种时发射此事件，载荷 `{ mood }`。每回合最多一次，情绪没变不发。世界或插件也可以用事件覆盖故事提示。
- `scene.set`（由跟踪场景的插件声明）：本插件继续订阅，事件可覆盖故事的场景提示。直接读取 `cues.scene` 不依赖场景舞台，即使没有场景事件提供者，也能按场景选曲。

同回合显式事件在故事提示之后处理，覆盖对应结果。两个事件仍参与同回合预览：槽位提供者声明了 `preview`，音乐在回合提交前就会跟着切换。

## 开发

修改选曲规则、事件载荷或槽位输出后，运行本插件测试：

```bash
pnpm --filter @covel/plugin-soundtrack test
```
