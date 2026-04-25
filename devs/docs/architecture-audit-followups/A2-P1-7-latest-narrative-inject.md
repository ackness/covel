# A2-P1-7 · `runtime-output-history` inject kind

来源：`audits/2026-04-25-docs-code-framework-alignment/RECOMMENDATIONS.md` §P1-7

## 问题

dashscope-image-gen/prompt-generator 通过默认消息历史去找"当前画面"，依赖 LLM 自己从长上下文中挑出最近一段叙事。在压缩、长上下文裁剪、消息顺序变化时，prompt 质量退化、生成的图与画面失配。

需要一种只读、确定性的 inject，让插件作者声明"把上一段 narrator 的输出贴到 prompt 里"。

## 当前能力

- `input.inject` 已有两种 kind：
  - `runtime`（默认）：当前 turn 内 upstream runtime 的 output 字段。
  - `plugin-data`：自身插件命名空间的 plugin_data 摘要。
- runtime_outputs 表里其实保留了历史 turn 的所有 runtime 输出，包括 `core-narrator`。
- `packages/context/src/context-builder.ts` 的 `needsAsyncBuild()` 已经识别 `kind: 'plugin-data'` 走异步路径，是新增 kind 的天然落点。

## 实施方案

1. 在 `packages/shared/src/schemas/plugin.ts` 新增 schema：
   ```ts
   export const runtimeOutputHistoryInjectDeclSchema = z.object({
     kind: z.literal('runtime-output-history'),
     from: z.string().min(1),       // upstream runtime id (e.g. core-narrator)
     field: z.string().min(1),      // output 字段（如 narrativeOutput）
     mode: z.enum(['latest']).default('latest'),
     as: z.string().min(1),         // XML 包裹标签（<latest-narrative>）
     // 后续可加 windowTurns / minPriority 等过滤
   }).strict();
   ```
   合并到 `inputInjectDeclSchema` 的 discriminated union。
2. `packages/shared/src/types/plugin.ts` 新增对应的 TS 类型。
3. `packages/context/src/context-builder.ts`：
   - `needsAsyncBuild()` 把 `runtime-output-history` 视作 async 触发条件。
   - `buildInjectBlocksAsync()` 内对该 kind 调用新 reader：
     ```ts
     async function readLatestRuntimeOutput(
       store: DataStore,
       sessionId: string,
       runtimeId: string,
       field: string,
     ): Promise<string | null>
     ```
     实现：用 `store.listRuntimeOutputs(sessionId, { runtimeId, limit: 1 })` 拿最新一条，再读 `output[field]`；返回 null 时跳过 inject。
4. `packages/store` 暴露 `listRuntimeOutputs` 已存在则复用，否则补一条最小查询接口（限定 sessionId + runtimeId + limit）。
5. 更新 `~/.covel/plugins/dashscope-image-gen/runtimes/prompt-generator/PLUGIN.md`：
   ```yaml
   input:
     inject:
       - kind: plugin-data
         namespace: prompts
         as: "<previous-image-prompts>"
         format: ids-only
         maxEntries: 8
       - kind: runtime-output-history
         from: core-narrator
         field: narrativeOutput
         mode: latest
         as: "<latest-narrative>"
   ```
6. 文档：
   - `docs/guide/plugin-authoring-advanced.md` 增加 inject kind 列表 + runtime-output-history 用法。
   - `docs/reference/plugins.md` 描述新 kind。

## 风险

- `runtime_outputs` 表如果还没有同时按 sessionId + runtimeId 的索引，`limit: 1` 查询性能可能差。先确认 `packages/store/**/runtime-outputs*.ts` 的索引设计，必要时加复合索引。
- 跨 session 误读：reader 必须强制 `sessionId` 过滤，不允许在 schema 里暴露 `sessionId` 参数。
- 若 `core-narrator` 在当前 session 还没有任何输出（首轮点击生成图），inject 可优雅降级（留空标签或不输出标签），prompt-generator 自己回退到默认行为。

## 验收标准

- 手动点击生成图片时 prompt 中包含明确 `<latest-narrative>` 标签，内容来自 `core-narrator` 最近一轮的 `narrativeOutput`。
- prompt-generator 的图像 prompt 与画面叙事一致性显著提升（人工抽测 5 例）。
- 新增 `packages/context/tests/runtime-output-history.test.ts`，覆盖空数据降级、跨 session 隔离、limit=1 路径。

## 参考文件

- `packages/context/src/context-builder.ts`
- `packages/shared/src/schemas/plugin.ts`
- `packages/shared/src/types/plugin.ts`
- `packages/runtime/src/turn-executor.ts`（async build 调用点）
- `~/.covel/plugins/dashscope-image-gen/runtimes/prompt-generator/PLUGIN.md`
