# 2026-03-25 架构与安全审计

> 注：这份文档记录的是一次只读静态审计快照。部分问题在后续提交中已经开始收口，例如默认监听地址、`/packages` DTO 收口、preset patch 护栏、pending block 持久化等；阅读时请结合当前代码状态判断是否仍然成立。

## 审计范围

- 仓库：`covel`
- 方法：只读静态审计，结合当前源码、测试和架构文档
- 约束：当前 worktree 是 dirty 的，且有多个 agent 并行工作；本次只整理 `docs/audit`，不改实现代码，避免和并行任务冲突
- 口径：按 MVP 视角评估，优先区分“会阻断流程跑通 / 明显扩大攻击面”的问题，以及“已知风险，可暂缓”的问题

## 结论摘要

当前架构方向基本是对的，尤其是这几条主线已经成形：

- `modules/model-gateway` 已经成为唯一模型出口，业务层没有直接调用 OpenAI/Anthropic SDK 或直接打 provider HTTP。
- `modules/domain` + `modules/storage` 的仓储接口稳定，in-memory / PostgreSQL 双路径也已经存在。
- `apps/web` 仍然保持三栏工作台，且基本通过 `api.ts` / `state.ts` 组织前端逻辑。
- `modules/storage/src/artifact-path-policy.ts` 和 `modules/package-runtime/src/path.ts` 已经有明显的路径安全意识。

但如果按当前默认运行方式来评估，整体风险仍然偏高：

- 如果 runtime 继续默认监听 `0.0.0.0`，并且没有任何认证层，那么风险评级是 `高`。
- 如果它被严格限制在本机单用户开发环境，很多问题可以先记为“已知风险”，但仍有几项会直接影响 MVP 的真实性和可持续迭代。

下面按优先级拆开。

## P0：建议优先处理

### 1. runtime 默认对外监听，但所有业务路由都未鉴权

- 证据：
  - `apps/runtime/src/main.ts:18-19` 直接监听 `0.0.0.0`
  - `apps/runtime/src/server.ts:59-257` 和 `apps/runtime/src/server.ts:275-340` 暴露了 `/worlds`、`/sessions`、`/messages`、`/packages`、`/presets`、`/archives`、`/traces`、`/actions`
  - 整个 `server.ts` 没有 authn/authz、IP allowlist、CSRF、session、basic auth、tenant 或角色判断
- 影响：
  - 任何能连上端口的人都可以改状态、看消息、看 trace、恢复 archive、改 preset、触发模型调用
  - 这不是“纯本机风险”，因为默认就是对局域网开放
- MVP 判断：
  - 如果你明确只打算本机单用户开发，这个问题可以通过“先改为只监听 `127.0.0.1`”来临时收口
  - 但如果要共享给同网段、反代、远程访问，必须优先处理
- 对比 SillyTavern：
  - SillyTavern 默认 `listen: false`，即默认只监听回环地址；只有显式开启才对外开放
  - 它还有 whitelist、basic auth、登录和 CSRF 保护

### 2. `/presets` 当前是配置投毒面，后续会演化成 SSRF 和 secret 外带面

- 证据：
  - `apps/runtime/src/server.ts:177-186` 接受任意 `PATCH/PUT /presets/:id`
  - `apps/web/src/components/preset-editor.ts:58-69` 前端允许直接编辑 `baseUrl`
  - `apps/runtime/src/composition.ts:121-142` 从环境变量读取真实 provider `apiKey`
  - `apps/runtime/src/composition.ts:220-224` 把 persisted preset 合并进 active profile
  - `apps/runtime/tests/composition-persisted-presets.test.ts:13-72` 明确验证“持久化 preset 可以覆盖 runtime preset”
  - `modules/model-gateway/src/provider-registry.ts:520-537` 发送请求时会带 `Authorization: Bearer ${config.apiKey}`
- 影响：
  - 当前接口没有鉴权，任何调用方都能改 `baseUrl`
  - 在 PostgreSQL 持久化路径里，这种改动会在下次启动后成为 active routing
  - 一旦后续模型请求打到这个地址，就会把真实 bearer key 一起带出去
  - 这同时是配置投毒、SSRF 和 secret 外带问题
- MVP 判断：
  - 这是少数即使在 MVP 也不建议完全忽略的问题，因为它直接把“用户可编辑配置”和“带 secret 的 provider 出站”绑在了一起
  - 如果暂时不做完整权限体系，至少也要做一个非常薄的护栏：`baseUrl` 限制为 allowlist，或在非开发模式下禁止 runtime API 修改它
- 对比 SillyTavern：
  - SillyTavern 也是后端代发 provider 请求，但 API key 保存在服务端 `secrets.json`
  - 它在“网络暴露”和“访问控制”上有更多默认收口；当前 `covel` 还没有这一层

### 3. 扩展系统现在是“代码执行边界”，还不是“能力边界”

- 证据：
  - `apps/runtime/src/composition.ts:103-109` 启动时发现并启用 `extensions/` 下的所有包
  - `modules/package-runtime/src/runtime.ts:157-168` `enable()` 会直接加载包内容
  - `modules/package-runtime/src/runtime.ts:254-257` 和 `339-356` 会动态导入扩展命令模块
  - `modules/package-runtime/src/manifest.ts:36-51` 虽然声明了 `permissions` / `reads` / `writes` / `modelPolicy`
  - 但 `apps/runtime/src/composition.ts:230-247` 仍把 `archiveService`、`packageRuntime`、`runtimePreset`、`ingestionRegistry`、`observability` 统一注入给所有命令，没有做权限裁剪
- 影响：
  - 现在只要有人把一个合法 manifest + command module 放进 `extensions/`，runtime 重启后就会执行
  - 在“很多 agent 并行操作仓库”的工作模式下，这不是抽象的供应链问题，而是现实信任边界
  - manifest 里的权限字段现在更像“文档声明”，不是可执行安全契约
- MVP 判断：
  - 如果当前阶段所有扩展都由你自己维护，可以先不做完整 sandbox
  - 但至少建议把“自动启用”改成“显式 allowlist”或“已批准包列表”
- 对比 SillyTavern：
  - SillyTavern 有安装/启用分离、第三方扩展免责声明、本地/全局扩展区分，以及更明确的来源信任概念
  - 当前 `covel` 还停留在 manifest 级别，没有运行时治理层

### 4. 有两个会直接影响“流程能否跑通”的状态一致性问题

#### 4.1 进程内自增 ID 会在持久化路径里制造覆盖风险

- 证据：
  - `apps/runtime/src/composition.ts:18-20` 的 ID 工厂是进程内计数器
  - `modules/storage/src/postgres-storage-port.ts:197-205`、`240-249`、`287-303` 等保存逻辑都采用 `on conflict (id) do update`
- 影响：
  - 进程重启后，`world_1`、`session_1`、`msg_1` 这类 ID 会重新开始生成
  - 在 PostgreSQL 路径里，这不是简单重复，而是可能直接覆盖历史记录
  - 多实例部署时风险更高
- MVP 判断：
  - 这是会破坏数据正确性的 P0 问题，比很多“纯安全细项”更应该先处理

#### 4.2 interactive block 状态只存在内存里，重启或多实例后无法恢复

- 证据：
  - `modules/flow-engine/src/runtime.ts:61-68` 把 pending block 放在进程内 `Map`
  - `modules/flow-engine/src/runtime.ts:144-149` / `210-215` 写入 `waiting_for_input`
  - `modules/flow-engine/src/runtime.ts:239-244` 只有内存里还能找到 `blockId` 时才能继续
- 影响：
  - session 状态会被存成 `waiting_for_input`
  - 但 runtime 一旦重启，真正的待响应块上下文丢失，流程就恢复不了
- MVP 判断：
  - 如果你要证明“interactive block 流程已经跑通”，那它至少要能跨一次重启或服务重建继续
  - 否则这条主链路还不算闭环

#### 4.3 当前 `guide` 扩展还在用固定 block 元数据，存在跨会话碰撞

- 证据：
  - `extensions/core-guide/server/commands/guide.ts:24-33` 固定写死了 `blk_guide`、`req_guide`、`tr_guide`、`ses_guide`、`turn_guide`
- 影响：
  - 多次触发 `/guide` 会复用同一个 block identity
  - 在 resume / trace / session 隔离上都会产生混淆
- MVP 判断：
  - 这是典型的“演示能过，但真实流程不可靠”的问题，建议尽快收口

## P1：建议尽快修，但可以晚于 P0

### 5. preset 编辑链路和 active runtime 脱节，默认 in-memory 模式下几乎没有真实效果

- 证据：
  - `apps/web/src/components/preset-editor.ts:58-69` 前端允许编辑 preset
  - `apps/runtime/src/composition.ts:199-200` 只有 PostgreSQL 路径才会在启动时读取 persisted presets
  - `apps/runtime/src/composition.ts:220-224` profile registry 只在 composition 创建时装载一次 persisted presets
- 影响：
  - 运行中编辑 preset，不会热更新 active `modelGateway`
  - 默认 in-memory 路径里，重建 composition 后这些编辑甚至不会被重新加载
  - 也就是说，这个“可编辑 preset” 功能目前更像 UI 幻象，而不是可靠能力
- MVP 判断：
  - 这不是安全问题，但它直接影响“配置能否真正驱动运行时”，建议在 P0 之后优先修正

### 6. trace 链路 split-brain，导致 API 看不到真实运行轨迹

- 证据：
  - `apps/runtime/src/composition.ts:313-324` 把 trace 写进 `observability.recordTrace(...)`
  - `apps/runtime/src/server.ts:212-231` 的 `/traces` 却只读 `repositories.traceRecords`
  - `modules/observability/src/runtime.ts:30-63` 是独立的内存 trace 存储
- 影响：
  - `/actions` 返回的 `traceId` 不代表 `/traces` 一定能查到内容
  - 对调试、回归定位和后续审计都不友好
- MVP 判断：
  - 如果 trace 面板是产品的一部分，这个问题应尽快修
  - 如果它只是调试附属，可以先记为“已知缺口”

### 7. `/packages` 暴露的是内部运行时对象，不是公开 API DTO

- 证据：
  - `apps/runtime/src/server.ts:160-164` 直接返回 `packageRuntime.listPackages()`
  - `modules/package-runtime/src/runtime.ts:64-70`、`328-335` 的 `RuntimePackageRecord` 包含 `rootDir`、`manifest`、`skillMarkdown`
  - `apps/runtime/src/composition.ts:106-109` 会在启动时加载所有扩展的 `SKILL.md`
- 影响：
  - API 会泄露绝对路径、完整 manifest 和技能说明内容
  - 这些都是内部运行时信息，不适合作为稳定对外接口
- MVP 判断：
  - 如果目前只是本地开发，可以暂时接受
  - 一旦有远程访问或多用户场景，建议尽快收口成 `{ name, enabled }` 这类 DTO

### 8. PostgreSQL preset patch 会静默清空已有 `apiKey`

- 证据：
  - `modules/storage/src/postgres-storage-port.ts:586-608` 的 `patch()` 先调 `getById()`
  - `modules/storage/src/postgres-storage-port.ts:610-639` 的 `getById()` 返回的是去 secret 后的视图
  - `modules/storage/src/postgres-storage-port.ts:556-584` 的 `save()` 会把 `api_key` 写回数据库
- 影响：
  - “只改 model/baseUrl/enabled” 这类普通编辑，也可能把已有 `apiKey` 清成 `null`
  - 这会导致后续 provider 请求直接失效
- MVP 判断：
  - 这是很典型的“用户会踩中”的 correctness bug，优先级高于很多通用安全细节

## 已知风险：可以先标记，不急着在 MVP 立刻处理

下面这些问题成立，但如果当前目标只是本机单用户 MVP，可以先标记为 `known risk`：

- `apps/runtime/src/server.ts:8-16` 全量缓冲 request body，没有 body size limit
- 没有限流、超时、取消、慢请求保护
- `modules/observability/src/runtime.ts:66-89` 的敏感信息脱敏范围偏窄，只覆盖 `apiKey` / `api_key` / `authorization`
- `modules/storage/src/postgres-storage-port.ts:171-183` / `556-584` 的 preset secret 目前是明文落库，不适合未来多用户或托管场景
- 当前没有 CSRF、防主机头欺骗、可信代理识别等 Web 边界治理

这些风险在“仅本机开发”时可以先接受，但一旦进入：

- 共享给团队
- 局域网访问
- 反向代理
- 多用户
- 托管部署

就不应该继续拖延。

## 架构完成度评价

### 做得好的部分

- 模型出口统一：`modules/model-gateway`
- 存储接口稳定：`modules/domain` + `modules/storage`
- PostgreSQL 查询参数化，没有拼接 SQL
- artifact path 和 package path 都有明显的 traversal 防护
- Web Host 仍保持三栏结构，没有退化成把所有逻辑塞进 `App.tsx`

### 还没真正闭环的部分

- package contract 只接上了 command 主链路；`context` / `renderer` / `block schema` 还没有真正进入 runtime 主链路
  - 证据：`apps/runtime/src/composition.ts:230-252` 只注册了 `listCommands()`
  - 同时 `rg` 结果显示 `getContextProvider()` / `getRenderer()` / `getBlock()` 基本只在 package-runtime 自己和测试里使用
- preset 现在同时承担“业务可编辑元数据”和“真实 provider routing”的角色，职责过重
- observability、trace API、flow state 目前还是分离设计，不适合继续向多实例演进

## 和 SillyTavern 的可借鉴点

这次额外参考了 `SillyTavern/SillyTavern` 的相关实现和文档摘要，主要有三点值得借鉴：

### 1. 网络暴露默认值要保守

- SillyTavern 默认是 loopback-only，只有显式开启才监听外网
- 同时提供 whitelist、basic auth、登录、CSRF 这些可渐进启用的收口层
- 对 `covel` 来说，最现实的第一步不是立刻做完整用户系统，而是先把默认监听地址和最薄的访问控制补上

### 2. 扩展要有“安装 / 启用 / 信任来源”分层

- SillyTavern 不会把本地扩展目录里的内容一律当成“默认可执行”
- 它有启用/禁用、系统/本地/全局扩展区分，以及第三方扩展风险提示
- `covel` 现在最缺的不是更复杂的 manifest，而是最基本的批准边界

### 3. secret 和可编辑配置不要走同一条信任链

- SillyTavern 的 API key 由服务端持有
- 即使 UI 可编辑 provider URL，它的整体网络暴露和访问控制也更完整
- `covel` 现在的问题不是“能不能编辑 baseUrl”，而是“任何能打到 runtime 的请求都能编辑 baseUrl，而且编辑结果会和真实 bearer key 组合生效”

参考链接：

- 扩展启用/信任边界：<https://deepwiki.com/search/sillytavern_d03a0cf5-6881-44e1-b966-29291adcbcc8>
- provider secret / base URL / 代理：<https://deepwiki.com/search/sillytavern-llm-provider-api-k_cad34e8a-4d78-499e-be3a-b6129c783ec6>
- 网络暴露 / auth / CSRF：<https://deepwiki.com/search/sillytavern-csrfbasic-authlogi_683f57e6-2472-4d7f-a1e5-1cf206d96b97>

## 建议的修复顺序

1. 先把 runtime 默认监听地址收回到 `127.0.0.1`
2. 收口 `/presets`：至少先禁改 `baseUrl` 或改成 allowlist
3. 去掉扩展自动启用，改成显式批准列表
4. 修 ID 生成和 pending block 持久化，确保 interactive flow 真能跑通
5. 修 preset 编辑链路，让 UI 配置真正影响 active runtime，或者干脆先隐藏这个能力
6. 统一 trace sink，避免 `/traces` 成为假功能
7. 再处理 body size limit、限流、脱敏扩展、secret at rest 等更通用的治理项

## 最终判断

这个仓库现在不是“架构方向错了”，而是“核心边界已经长出来了，但治理层还没补齐”。  
如果你的目标是尽快把 MVP 跑通，那么真正应该优先处理的不是所有安全细节，而是这四类问题：

- 默认网络暴露过大
- preset 配置可投毒
- 扩展执行边界没有批准和权限收口
- 状态连续性不足，导致 interactive flow 和持久化路径并不真正可靠

这些问题收住之后，剩下的很多安全项都可以合理地作为 `known risk` 暂挂，而不会阻断 MVP 前进。
