# chat-mode-narrator

对话模式叙事器，重点处理角色对白、当前说话人和人物互动。

## 运行时结构

- `PLUGIN.md`：单 agent runtime 和玩家可调设置。
- 不依赖任何其他插件：有 `scene-stage` 的 cast runtime（`scene-cast@1`）时读取当前在场角色上下文，没有时按世界、历史和玩家输入里在场的角色退化为纯对白叙事。
- 可读取 `npc-graph/rag-retriever` 提供的人物关系上下文。
- 常驻 prompt 只使用世界名称、简介和标签；由世界上下文扩展提供世界条目。
- 玩家角色卡（`<player-character>`）由 entry 注册的回合级提示段提供，排在历史之后；正文里只写块名，system prompt 不随角色卡变化。
- 可调用 `memory-search` 检索已离开当前窗口的旧对话、承诺和线索。
- `advertiseEvents: true`，可调用 `emit-event` 发射当前会话已声明的领域事件。

## 数据与行为

- 为对话模式世界生成 `outputKind: story` 的主叙事。
- 说话者一变就另起一个段落，段落带说话者名字；舞台名牌来自段落。`stage.direction` 只调整演员登场、离场、站位、造型和聚光，演员焦点只控制视觉强调。
- 通过 manifest relations 和默认 `narrator` 互斥。
- 暴露对白占比、回复长度、活跃说话人数等玩家设置。

## 视角

`perspective` 支持 `character-first`、`character-second`、`character-third`、`omniscient`、`dm`，默认 `character-second`。玩家设置覆盖世界 `pluginSettings` 中的默认值。`character-*` 三种从玩家角色的有限视角讲述，分别用“我”“你”或角色名称呼玩家角色；`omniscient` 是全知第三人称旁白，旁白里不出现“我”和“你”；`dm` 是主持人口吻，可以用“你/你们”称呼玩家，不检查人称。只调整后续旁白，保留人物对白和玩家自主权。

## 故事段落

输出声明 `io.output.schema: contract:narrative-engine@2`，模型以 JSON 返回故事段落（`segments`：`narration`、`dialogue`、`action`，对白和动作带说话者名字），并可在 `cues.present` 列出在场角色。框架把段落文字用空行连接成 `narrativeOutput`，提交时把说话者名字解析成角色，舞台名牌直接读取段落的说话者。格式出错时框架按输出修复预算请求模型改正，只有没有任何正文时才失败。检查草稿时逐段读取段落文字。

## 开发

修改提示词后，运行覆盖 prompt 拼装和对话模式世界策略的 runtime 测试。

人物档案：叙事可通过 `list-characters` / `get-character` 查询当前会话内的完整角色资料，包括尚未出场的 NPC。身份和属性优先核对档案，历史记忆用于查询发生过的事件。

## 输出检查

通过公开 Hook 缓冲模型草稿，检查引号外的旁白是否符合当前人称。发现问题后限次请求模型纠正，不做全局代词替换；查询时的准备说明不进入正文。正文在检查通过后整段展示，最多增加两次纠正调用。人物对白和既有历史保持原样。

查不到角色档案不代表世界设定中没有这个人物；事实依据仍由世界资料、角色档案和提示词共同约束，不用关键词检查强制模型回答“未知”。这不是通用事实验证器：复杂暗示、冲突的旧档案仍需要核对，不能把文本检查通过等同于所有故事事实都正确。
