# World IR

`world-ir` 是通用的叙事事实抽取管线。它通过 `inputs.narrative` 按 `narrative-engine` capability 获取当前故事输出，只调用一次 `plugin` 模型，并产生严格校验的 `covel://world/ir/v1`。

同轮下游 runtime 应声明：

```yaml
inputs:
  worldIR:
    from:
      capability: world-ir-provider
      cardinality: one
    required: true
```

框架由 typed input 自动建立 DAG 边、失败 gate 和 provenance；agent 在 `<runtime-inputs>` 的 `worldIR.value` 读取 IR。插件包在 `relations.requires` 中声明 `world-ir`，让 session 选择器自动补齐生产者。`output.recordAs: world-ir-v1` 还会把成功结果保留为可发现的跨执行 export。

该设计不会修改 narrator/story prompt。代价是一条额外的串行抽取调用；当两个以上结构化插件复用结果时，通常可用更短、更稳定的下游输入抵消。新增只有一个消费者、且确实需要完整原文的独立能力时，可以直接绑定 `narrative-engine`，无需为了形式统一强制经过 WorldIR；现有图鉴、任务、关系、物品和好感插件则统一选择共享契约，以保持组合行为和失败语义一致。
