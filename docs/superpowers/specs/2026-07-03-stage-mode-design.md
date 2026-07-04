# 舞台模式（Stage Mode，GalGame 四部曲 C）设计

> 终章 C，依赖 D/A/E/B 全部落地。纯前端（apps/web）+ 1 个世界包可选字段；零后端新机制——消费 B 的 `stage/current`、scene-cast 的 `active-cast`、character-presence 立绘、scene-prompts 短句与既有 interaction/流式通道。
> 视觉决策经浏览器原型对比选定（原型存 `.superpowers/brainstorm/`）：全屏舞台 · 打字机流式+分段停顿 · 经典选择肢覆盖层 · 立绘纯站台+亮度强调。

## 范围

**做**：`viewMode: "stage"` 档 + 世界默认声明；stage/ 组件六件套；打字机/选择肢/立绘/背景/HUD/履历抽屉；回退链前端落点；表单模态复用；组件单测 + Playwright 视觉回归；docs 同步。

**不做**：手机端专门优化（响应式可用即可）；逐句说话人识别（名牌为回合级主发声者——升级路径：E 层加 `speaker.turn` 事件声明，narrator 逐句 emit）；"保存到世界级"入口（依赖真实生成资产流通后另立小规格）；BGM/音效；pre-game 阶段舞台化（表单密集，沿用现有流程）。

## §1 入口与模式

- `GameViewMode` 增 `"stage"`；header 切换器加档（图标区别于 parsed/detailed/raw）。
- world.yaml 新可选字段 `defaultViewMode: "stage" | "parsed"`（缺省 parsed）——shared world schema + 加载链 + `WorldRecord` 前后端类型同步；haruka-academy 声明 `defaultViewMode: stage`。玩家手动切换后以玩家选择为准（会话内记忆，沿用 viewMode 现有持久化机制）。
- 舞台仅接管 **Playing 阶段**（`turnCount >= 1`）的中央面板主体；pre-game / session-prep 不变。header 与左右 rail 保持。

## §2 组件（`apps/web/src/components/session/stage/`）

| 组件            | 职责                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StageView`     | 模式根：Playing 时替换 ChatMessages+PendingDraftsBar+MessageComposer 区域；组织下述层级；托管履历抽屉与表单模态                                                                                                                                                                                                                                                                                                                                     |
| `StageBackdrop` | 背景层：读 scene-stage `stage/current` → `resolved` MediaRef → media-resolve URL；场景切换 600ms crossfade（双 img 层轮换）；§4 回退链                                                                                                                                                                                                                                                                                                              |
| `StageSprites`  | 立绘层：scene-cast `active-cast.speakers` × character-presence sprite refs；**粘性站位**（决策 5）：salience 只决定谁上场/谁高亮，站位只在成员进出时按"最近空位"重排；**等宽泳道几何**（决策 6）：舞台按人数均分泳道、立绘道内 contain，构造上不遮挡；主发声者（speakers[0]）全亮+光晕+scale(1.03)+置顶，其余 brightness(.55) saturate(.6)；进出场 300ms opacity/transform 过渡，让位滑移 500ms；无 sprite 的角色渲染名字首字占位卡（修订于实现期） |
| `StageDialog`   | 对话框：消费流式 StreamMessage（outputKind story 的最新回合）；**打字机由真实 delta 驱动**（到达字符入队按节奏放出，队列空则等待）；`\n\n` 段界自动停顿显示 ▼，点击放行下一段；停顿外点击 = 立即放完当前段（跳过）；名牌 = active-cast 主发声者名；回合叙事完成且全部段放完 → 通知选择肢层                                                                                                                                                          |
| `StageChoices`  | 选择肢覆盖层（舞台中央纵列浮现）：interaction.request 的 choice 类在上、scene-prompts 短句居中、`✎ 自己输入…` 恒垫底；点击选择肢 = 直接提交（interaction 走既有 onSubmitInteraction，短句走 onSendMessage）；✎ 将对话框切为输入态（textarea + 发送，Esc 返回）；6 条以上双列                                                                                                                                                                        |
| `StageHud`      | 左上：场景徽标（`stage/current` 的 name + 日/夜图标 + `sourceLabel`，pending 时呼吸动画）；右上按钮组：履历 · 自动播放（定时推进段落，再点关闭）· 切回聊天流（viewMode=parsed）                                                                                                                                                                                                                                                                     |

- 履历抽屉：右侧 Drawer 内嵌**现有 `ChatMessages` 组件**（完整 props 透传）——历史、重试、分支、表单回看零新开发。
- `interaction.request` 的 **form 类**：舞台上弹既有 json-render 模态（复用 MessageBlockRenderer 的表单通道），提交链不变。
- 数据获取全部走既有 hook：`usePluginData`（scene-stage / scene-cast / scene-prompts 的 namespace 为**数据绑定**，非控制流——符合隔离规则的 curated data 例外）、`useSession` 流式消息、`media-resolve`。

## §3 打字机状态机（核心交互，单测重点）

状态：`idle → typing(段内放字) → pause(段界 ▼) → typing … → done(全段放完) → choices`。

- 输入事件：`delta(chars)`（流式到达入队）、`click`（pause→放行下段 / typing→瞬间放完当前段）、`streamEnd`（narrative 完成标记）、`auto`（自动播放定时触发 click 等价）。
- 段界 = 已到达文本中的 `\n\n`（流式中段界之后的文本继续入队，不阻塞接收）；流式落后时 typing 态自然等待（光标闪烁）。
- 跳过语义只作用于**当前段**（双击不会吞掉未读段——GalGame 惯例）。
- done 判定 = streamEnd 已收 && 队列放空 && 无未读段。

## §4 回退链（A §4 / B §4 的前端落点）

| stage/current 状态                    | 背景呈现                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `resolved` 有图                       | 场景图（crossfade 进场）                                                                           |
| `source:"pending"`                    | 上一张背景（无则世界头图）+ HUD 呼吸态"背景生成中…"；`plugin-data.changed` 到达后 crossfade 换新图 |
| `source:"none"` / 无 scene-stage 数据 | `worldVisual` 世界头图 → 主题色渐变                                                                |
| scene-cast / presence 无数据          | 无立绘（纯背景+对话框照常）                                                                        |
| scene-prompts 无数据                  | 选择肢只剩 interaction choices（如有）+ ✎ 输入                                                     |

每层缺失都不弹错、不阻塞——纯文字舞台成立（背景+对话框+✎）。

## §5 视觉与动效纪律

- 动画只用 compositor-friendly 属性（opacity/transform/filter 谨慎）；`prefers-reduced-motion` 时打字机改整段显示、转场改瞬切。
- 主题：舞台自身为暗景（图上文字），但 HUD/选择肢遵循应用主题 token；光暗两主题下的选择肢/对话框对比度都要设计（视觉回归覆盖两主题）。
- 设计质量按仓库 web 规则：非模板化、层次/景深/动效有意图（舞台本身即层叠构图）。

## §6 测试

- 组件单测（vitest）：打字机状态机（delta 乱序节奏/段界/跳过/streamEnd 时序）、选择肢合并排序（choices>prompts>✎、双列阈值）、回退链分档、立绘站位与高亮计算。
- Playwright 视觉回归：320/768/1024/1440 × 光暗主题，舞台三态（有图/pending/纯文字）截图。
- e2e（用户执行）：真实叙事 3 轮走舞台全链路（出图后）。

## 决策记录

1. 全屏舞台 / 打字机流式+分段停顿 / 经典选择肢覆盖层 / 立绘纯站台+亮度强调——四项均经浏览器原型对比由用户点选。
2. 立绘不做卡片降级（用户选 A 而非混合 C）：非透明底旧立绘原样站台（视觉略生硬，重生成透明底即愈）——**修订 A 规格 §4 回退表的"卡片式呈现"行**为"原样站台"。
3. viewMode 新档 + 世界默认声明（用户选定）；履历复用 ChatMessages、桌面优先（用户选定）。
4. 逐句说话人识别后置（升级路径经 E 层事件）。
5. **粘性站位（2026-07-03 修订，替换原"按人数均布"）**：原设计按 speakers 数组下标查 count→站位表，而 scene-cast 每回合按 salience 重排数组，导致换说话人/换场景时立绘左右互换（漂移）。修订为 `assignStations` 纯函数：① 成员不变站位不变（salience 只移动高亮）；② 站位只在上/下场时重排且移动最小化——留场者原地不动，被挤占者与新人以"记忆站位 ?? center"为目标取最近空位（平局取左，初排自然主发声者居中）；③ 离场保留站位记忆，回场回原位；④ 空 cast 过渡回合沿用 sticky 阵容、记忆不动；⑤ 合法让位用 500ms left 过渡（reduced-motion 折叠）。记忆存组件 ref（渲染期更新，函数幂等，StrictMode 安全）。
6. **等宽泳道几何（2026-07-03 修订，替换原"中心锚点 + 固定百分比偏移"）**：原实现立绘高度定 92%、宽度随图片宽高比自适应、中心锚在固定百分比站点——宽幅（非透明底）立绘的实际宽度与"舞台高/宽比"耦合，中央面板变窄（rail 展开等）时立绘互相压盖，遮挡程度不可控。修订为 `computeSpriteLanes`：站位只决定左右次序（rank），几何上舞台按人数均分等宽泳道，立绘在道内以 contain 缩放（宽度受泳道即舞台宽度百分比约束，不再受高度×宽高比支配）——**遮挡在构造上不可能**；独角时泳道上限 60% 居中，防宽卡铺满背景；active 说话人 z 置顶处理光晕边缘残余交叠。人数增减时泳道 left/width 500ms 滑移。
