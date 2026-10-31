# 世界事实提取 (World IR)

`world-ir` 是通用的叙事事实抽取管线。它通过 `runtime.io.inputs.narrative` 按 `narrative-engine@2` 契约选择当前故事的 `/segments`，保留逐段的 `kind`、`speaker` 和 `text`，并要求模型调用一次 `submit-world-facts`。工具补齐省略的协议常量 `schemaVersion: 1`（显式非法版本仍拒绝），参数按共享 World IR schema 校验，成功的工具结果会直接成为严格校验的 `contract:world-ir@1` 输出。

同轮下游 runtime 应声明：

```yaml
runtime:
  io:
    inputs:
      worldIR:
        from:
          contract: world-ir-provider@1
          cardinality: one
        accepts: contract:world-ir@1
        required: true
```

框架由 typed input 自动建立 DAG 边、失败 gate 和 provenance；agent 在 `<runtime-inputs>` 的 `worldIR.value` 读取 IR。消费者包根声明 `requires: [world-ir-provider@1]`，让会话依赖解析器补齐生产者。生产者的 `runtime.io.output.recordAs: world-ir-v1` 还会把成功结果保留为跨执行 export。

每次校验失败都要多一轮模型调用，所以工具先修正机械性失误：丢弃误抄进参数的抽取输入、把写在事实顶层的细节移入 `attributes`、给没写 `id` 的关系 / 事件 / 陈述补一个取自内容哈希的 id（以 JSON 文本传入的数组由 `tool()` 统一解析）；会话角色在抽取输入里以姓名生成的单词短名出现（如 `tomas-reed`），模型直接引用、不重复登记，工具把短名还原成真实 id 并按会话角色名册补登记；这样 UUID 不会在输出里被反复抄写。短名的连字符写在别处、或直接写了姓名时（`雷恩-修女` 对 `雷恩修女`），只要字母和数字与唯一一个角色的短名相同，也按该角色处理。引用处写的是本次输出里某个实体的名称而不是 id 时（且只有一个实体叫这个名称），按该实体的 id 处理。`vocabulary` 里会话已在追踪的物品和任务也是已知对象：模型按提示沿用这些名称并直接当作 id 引用时，工具按词表给出的类型补登记。陈述的 `subjectIds` 里写了本次输出中某条事件或陈述的 id 时，工具去掉它：主体只能是实体。只有其他错误（例如引用了既未登记、也不在名册和词表里的 id）才会退回模型修正。

该设计不会修改 narrator/story prompt。函数调用避免模型把 `strength`、`actor` 等扩展字段误放到受限顶层；校验失败会把字段路径返回给模型，并允许下一步修正。`maxRetries: 3`：模型调用超时，或遇到网络错误、限流、5xx、服务商报告的生成错误时重试，不让一次瞬时故障丢掉整回合的事实抽取。`callTimeoutMs` 60 秒只约束非流式调用；流式调用按首次输出等待和之后的静默时间限时，工具参数分片也算有效输出。持续输出可延长请求预算，因此 `timeoutMs` 120 秒不是这类流的总耗时上限。重试共用一次逻辑请求的预算，规则见 [模型调用预算](../../docs/reference/slots.md#http-retry-cleanup)。参数校验错误不占重试次数，由下一个 agent step 修正。

插件的 `PostContextAssembly` hook 只保留本地化任务、权威 `inputs.narrative` 段落数组、角色单词短名/姓名名册，以及可选的 `vocabulary`（见下文）与本轮工具操作。原玩家输入不单独提供；单项重试仍只读取恢复的源故事段落，不拼接新执行的输入或当前受控角色。未进入这些段落的玩家话语或承诺无法由此恢复。叙事中的请求、尝试和假设不是成功结果；NPC 的台词或承诺不代表玩家接受。完整输出仍由公共 `narrative-engine@2` schema 在选择前校验，无需另复制一份段落 schema。用户消息里名册、词表、本轮工具操作依次排在正文前面：它们很少变，正文每回合都变，下一回合的请求因此与本回合从头相同到正文为止，服务商的前缀缓存可以覆盖这一段。完整历史、记忆块、旧世界状态不再重复发送；这样既避免把旧变化当作本轮变化，也降低提取请求体积。输出 token 数直接决定这一步的耗时，所以提示要求每个事实只写一次（事件不再复述为关系或陈述）、只登记本轮新出现的实体、attributes 只放下游要用的状态字段，以约 600 tokens 为典型输出目标，保留所有明确的物品、任务与状态变化；World IR 的结构上限保持不变。

`agent.reasoning: false` 默认关闭可选推理；`agent.finishWith: submit-world-facts` 要求模型每一步都调用工具，`submit-world-facts` 成功后结束。用户显式推理配置仍优先；对于 thinking 与强制工具不兼容的模型，adapter 保留用户配置并退回自动工具选择。叙事段落和身份数据分开保存在 user JSON，提示要求逐句核对施动者，无法解析的代词不猜姓名。结构校验能保证协议和引用完整，但无法保证所有模型生成事实的语义正确。

代价仍是一条额外的串行模型调用；当两个以上结构化插件复用结果时，通常可用更短、更稳定的下游输入抵消。新增只有一个消费者、且确实需要完整原文的独立能力时，可以直接绑定 `narrative-engine@2`，无需为了形式统一强制经过 World IR；现有图鉴、任务、关系、物品和好感插件则统一选择共享契约，以保持组合行为和失败语义一致。

## 固定字段事件与名称词表

`inventory_change`、`quest_change` 两类事件的 `attributes` 有固定字段（物品与持有者、任务名与状态），由 `submit-world-facts` 校验，字段表见 [tools.md · submit-world-facts](../../docs/reference/tools.md#submit-world-facts)。`inventory` 与 `core-quest` 的 function runtime 只读这些字段记账，不再各自调用模型；`affinity` 仍是 agent，从 `interaction` 等事件自行判断好感变化。

为让抽取沿用会话里已有的名称，`world-ir` 以 `cardinality: all` 可选输入读取 `world-ir.vocabulary@1`：提供者在 pre-turn 发布 `{ entries: [{ type, name, details? }] }`（如 `inventory/vocabulary` 发布物品名，`core-quest/vocabulary` 发布进行中的任务名与未完成目标）。词表只用于对齐名称，不是本轮发生了什么的证据。工具要求对每个未完成目标提交带正文引文的 `objectiveAssessments`，并检查与任务事件一致；评估不进入公开输出，也不写数据。字段和局限见[逐目标评估](../../docs/reference/tools.md#逐目标评估)。

## 本轮工具操作

`runtime.io.inputs.operations` 绑定内核输入 `operations@1`。非空时，hook 在 `vocabulary` 之后、`narrative` 之前加入 `operations: [{ contract, request, result }]`，不携带操作身份或提交信息；空列表不加入消息。操作是工具本轮已经作出的变化，正文呈现其中一项时，提取使用请求里相同的物品名和数量记录事件。正文没有呈现的操作不凭空生成事件。行囊可以据此避免重复记账，其他 WorldIR 消费者仍能读取同一事件，公开事实结构保持不变。
