# 世界事实提取 (World IR)

`world-ir` 是通用的叙事事实抽取管线。它通过 `runtime.io.inputs.narrative` 按 `narrative-engine@1` 契约获取当前故事输出，并要求模型调用一次 `submit-world-facts`。工具补齐省略的协议常量 `schemaVersion: 1`（显式非法版本仍拒绝），参数按共享 World IR schema 校验，成功的工具结果会直接成为严格校验的 `contract:world-ir@1` 输出。

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

每次校验失败都要多一轮模型调用，所以工具先修正机械性失误：丢弃误抄进参数的抽取输入、解析以 JSON 字符串传入的事实数组、把写在事实顶层的细节移入 `attributes`；引用会话已知角色却漏登记时，按会话角色名册自动补登记。只有其他错误（例如引用未登记的非角色 id）才会退回模型修正。

该设计不会修改 narrator/story prompt。函数调用避免模型把 `strength`、`actor` 等扩展字段误放到受限顶层；校验失败会把字段路径返回给模型，并允许下一步修正。`maxRetries: 0` 避免 provider 超时重试独占整个 120 秒 runtime 预算，同时保留第二个 agent step 处理参数校验错误。

插件的 `PostContextAssembly` hook 只保留本地化任务、权威 `inputs.narrative`（含来源）、角色规范 ID/姓名名册，以及可选的 `vocabulary`（见下文）。完整历史、记忆块、旧世界状态不再重复发送；这样既避免把旧变化当作本轮变化，也降低提取请求体积。提示要求简短描述、避免重复证据，以约 1000 tokens 为典型输出目标，保留所有明确的物品、任务与属性变化；硬性 World IR 上限和原有 60 秒单次时限保持不变。

`llm.reasoningEffort: disabled` 默认关闭可选推理，并以 `llm.toolChoice` 请求指定 `submit-world-facts`。用户显式推理配置仍优先；对于 thinking 与强制工具不兼容的模型，adapter 保留用户配置并退回自动工具选择。当前叙事和身份数据独立保存在 user JSON，提示要求逐句核对施动者，无法解析的代词不猜姓名。结构校验能保证协议和引用完整，但无法保证所有模型生成事实的语义正确。

代价仍是一条额外的串行模型调用；当两个以上结构化插件复用结果时，通常可用更短、更稳定的下游输入抵消。新增只有一个消费者、且确实需要完整原文的独立能力时，可以直接绑定 `narrative-engine@1`，无需为了形式统一强制经过 World IR；现有图鉴、任务、关系、物品和好感插件则统一选择共享契约，以保持组合行为和失败语义一致。

## 固定字段事件与名称词表

`inventory_change`、`quest_change` 两类事件的 `attributes` 有固定字段（物品与持有者、任务名与状态），由 `submit-world-facts` 校验，字段表见 [tools.md · submit-world-facts](../../docs/reference/tools.md#submit-world-facts)。`inventory` 与 `core-quest` 的 function runtime 只读这些字段记账，不再各自调用模型；`affinity` 仍是 agent，从 `interaction` 等事件自行判断好感变化。

为让抽取沿用会话里已有的名称，`world-ir` 以 `cardinality: all` 可选输入读取 `world-ir.vocabulary@1`：提供者在 pre-turn 发布 `{ entries: [{ type, name, details? }] }`（如 `inventory/vocabulary` 发布物品名，`core-quest/vocabulary` 发布进行中的任务名与未完成目标）。词表只用于对齐名称，不是本轮发生了什么的证据。
