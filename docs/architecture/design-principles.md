# Covel 设计原则

> 这页回答"Covel 为什么这么设计"。机制怎么连接看 [flow.md](./flow.md)；字段契约看 [`../reference/`](../reference/)；怎么写插件看 [plugin-authoring.md](../guide/plugin-authoring.md)；术语以 [glossary.md](../glossary.md) 为准。

## 基本目标

让任何创作者——会写代码的、不会写代码的、或一个 AI Agent——把一个游戏创意按规范写成声明，框架就能编排成可玩的场景。**规范约束"怎么接进框架"，不约束"能玩什么"。** 一次赛博潜入、一场法庭辩论、一回视觉小说表白，对框架是同一件事：一组按契约声明好的插件和 [World](../glossary.md)，被 [Kernel](../glossary.md) 一回合一回合编排。

## 核心：内核提供原语，插件承载玩法

Covel 的一切都从这条出发（CLAUDE.md 把它定为强制的 "Framework ↔ Plugin Isolation Rule"）：

- **Kernel**（`packages/` / `apps/server/src/` / `apps/web/src/`）只提供五个一类原语——**Runtime、Tool、Hook、Context、Proposal**——以及编排（调度、上下文装配、校验提交）。它不认识任何具体玩法。
- **插件**承载玩法逻辑：声明自己**何时触发、看什么 Context、用哪种 Runtime 执行、产出什么 Proposal**。

一个直觉比喻：插件长出标准"插头"（声明上面那几件事），Kernel 就能供电（编排 / 组合 / 复用）；插头后面接什么"电器"（你的逻辑、叙事、判断规则、世界观），Kernel 一概不碰。

### 一条裁决规则

要判断某件事该不该进 Kernel，问：**它是"插头"（接口 / 契约）还是"电器"（内容 / 逻辑）？**

- 是插头（如"插件怎么声明触发条件""有哪几种 Proposal 类型"）→ Kernel 管、要规范、进 `reference/`。
- 是电器（如"这个 NPC 该不该相信玩家"）→ Kernel 不碰，交给插件。

推论（CLAUDE.md 已强制）：**框架代码永不硬编码具体插件 ID，也永不为单个玩法改内核。** 当一个合理场景表达不出来时，正确动作是给 Kernel 加一根**通用**针脚（新 Proposal 类型 / 新 Hook 事件 / 新触发方式），而不是写死一段逻辑。这保证任何插件都能被替换而不动框架。

## 两个原语 + 组合 = 创作者的"三种写法"

每个 [Runtime](../glossary.md) 只有两种：

- **agent runtime** —— 用自然语言把规则写进 `PLUGIN.md`，LLM 读规则 + 上下文，自己判断、自己叙述。适合要理解 / 裁量 / 生成文本的玩法（让 LLM 当裁判）。
- **function runtime** —— 一段 JS handler，确定地读上下文 → 算 → 产出。适合要精确 / 公平 / 可复现 / 零成本的事（如掷骰的随机数——不能交给 LLM）。

创作者常把这两种叫"模式"，但 Covel **没有 "hybrid" 原语**：所谓"混合"，是把两种 Runtime 拼起来的**组合**，靠两种粘合——**Tool**（agent 调用一个函数支撑的工具，稳定触发确定逻辑）和 **input.inject**（把一个 runtime 的产出喂进另一个的 Context）。这样 Kernel 只需两块积木，创作者却能表达任意"既有规则、又有叙事"的玩法。掷骰范例与具体写法见 [plugin-authoring-agent.md §0](../guide/plugin-authoring-agent.md)。

> 术语提醒：这里的"写法 / 模式"指**执行方式**，与 glossary 的 **Trigger mode**（runtime 何时运行：auto / scheduled / manual / event）是两回事，不要混。

## 可表达的边界

任何能拆成"**何时触发 → 看什么 Context → 用哪种 Runtime 判断 → 产出什么 Proposal**"的回合制、叙事 / agent 驱动场景，框架都支持。拆不进这个范式的（实时动作、像素级物理）不是 Covel 的目标。完整 turn pipeline 见 [flow.md](./flow.md)。

## 失败隔离（为什么一律走 Proposal）

插件从不直接写库，一律产出 [Proposal](../glossary.md)，由 Kernel 校验后统一提交。这条模块边界换来三件事：一个插件崩了只丢自己的产出、不拖垮整回合；多个插件改同一处不打架；插件只看得到自己的数据。这就是"灵活但不失控"的根——也是 Kernel 与插件之间唯一的写入通道。

## 延伸

- 怎么写插件（按技能分三条路径）：[plugin-authoring.md](../guide/plugin-authoring.md)
- 端到端执行管线、状态模型：[flow.md](./flow.md)
- 术语权威定义：[glossary.md](../glossary.md)
- 隔离规则全文：CLAUDE.md "Framework ↔ Plugin Isolation Rule"
