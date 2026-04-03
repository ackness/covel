# 部署模型与安全架构

时间：2026-04-03
状态：草案

---

## 1. 部署层级（Deployment Tiers）

Covel 有三个部署层级，安全策略随层级递进：

| 层级 | 名称 | 用户 | 数据存储 | API Key 管理 | 认证 |
|------|------|------|---------|-------------|------|
| **T1** | 自部署（开源） | 单用户 | 浏览器 localStorage + IndexedDB | 用户自管（localStorage 或 `.env.llm`） | 无需（本机/私有网络） |
| **T2** | Demo 托管 | 多用户（隔离） | 浏览器 localStorage + IndexedDB（零服务端持久化） | 用户自管（仅 localStorage） | 无需（数据完全客户端） |
| **T3** | 商业化服务 | 多用户（共享基础设施） | 服务端 PostgreSQL | 平台提供 Provider + 用户自有 Key 混合 | 必须（用户认证 + 数据隔离） |

### 1.1 核心约束

- **T1/T2 共性**：服务器是**无状态代理**——不持久化用户数据和密钥，仅转发 LLM 请求。
- **T2 特殊**：Demo 实例暴露在公网，必须确保服务器不存储、不泄露任何用户的 key/数据。
- **T3 增量**：在 T1/T2 的架构基础上增加认证层、数据隔离层、计费层。当前架构需为 T3 预留扩展点，但不需要实现。

### 1.2 架构复用原则

```
T1（自部署）⊂ T2（Demo）⊂ T3（商业化）
```

所有层级共用同一套内核、插件系统、执行管线。差异通过以下机制注入：

- **Store 后端选择**：T1/T2 用 `IdbStore`（浏览器）或 `MemoryStore`；T3 用 `PgStore`
- **认证中间件**：T1/T2 无；T3 注入认证中间件
- **Provider 绑定**：T1/T2 由客户端 `X-Provider-Keys` 提供；T3 由平台 + 用户混合提供
- **环境变量控制**：`DEPLOYMENT_TIER=self|demo|commercial` 控制功能开关

---

## 2. API Key 安全模型

### 2.1 密钥流转

```
┌─────────────┐    X-Provider-Keys (base64)     ┌─────────────┐    Authorization: Bearer sk-...    ┌─────────────┐
│   Browser    │ ──────────────────────────────→ │   Server    │ ──────────────────────────────────→ │ LLM Provider│
│ localStorage │                                 │  (无状态)    │                                    │             │
└─────────────┘                                 └─────────────┘                                    └─────────────┘
      ↑                                               │
      │ 仅 T1 自部署时                                  │ 请求结束后丢弃
      │ /api/provider-keys                             │ 不写入 DB/文件/日志
      │ 自动填入 localStorage                           │
      └───────────────────────────────────────────────┘
```

### 2.2 各层级的密钥策略

| 层级 | `/api/provider-keys` 端点 | `X-Provider-Keys` Header | `.env.llm` |
|------|--------------------------|-------------------------|------------|
| T1 | 启用（返回部署者自己的 key，便利功能） | 支持 | 部署者自管 |
| T2 | **禁用**（Demo 服务器不持有用户 key） | 支持（唯一来源） | **不存在** |
| T3 | 替换为 `/api/provider-binding`（平台分配） | 支持（用户自有 key 覆盖） | 平台内部管理 |

### 2.3 安全保证

- 服务器**绝不持久化**从 `X-Provider-Keys` 收到的密钥
- 服务器**绝不在日志中记录**密钥内容（即使 error 日志）
- `X-Provider-Keys` Header 通过 HTTPS 传输（T2/T3 强制 HTTPS）
- `/api/provider-keys` 端点在 `DEPLOYMENT_TIER !== "self"` 时自动禁用

---

## 3. 插件安全模型

### 3.1 插件来源分级

| 来源 | 标识 | 信任级别 | 前端标记 |
|------|------|---------|---------|
| **官方内置** | `source: "builtin"` | 完全信任 | 绿色标记「官方插件·包含可信任脚本」 |
| **官方维护** | `source: "official"` | 完全信任，白名单免确认 | 绿色标记 |
| **社区第三方** | `source: "community"` | 不信任，需用户确认 | 橙色/红色标记「包含可执行脚本·请注意风险」 |

### 3.2 可执行脚本确认流程

```
加载插件 manifest
  → 检测 server/ 目录是否包含可执行脚本（.ts/.js 文件）
  → 检查 source 字段
  → if source ∈ builtin_whitelist:
      自动加载，前端绿色标记
  → else:
      阻止加载
      → 前端弹出确认对话框:
         「⚠️ 插件 {name} 包含可执行脚本，加载后将在服务器上运行。
          请确认你信任该插件的来源。」
         [查看脚本内容] [取消] [确认加载]
      → 用户确认后加载，记住选择（per-session 或持久化）
```

### 3.3 工具权限模型

> 来源：架构审计 20260403-141048 #8，`public-plugin-api-spec.md` §10/§15

当前状态：所有插件 manifest 中的 `permissions` 字段为空，且 builtin data tools（`state.*/record.*/event.*`）已定义但未注册进运行时。

**演进计划**：

1. **Phase 0（当前）**：`permissions` 字段存在但不执行约束
2. **Phase 1**：manifest validator 对非 `query` 类别工具强制要求声明 `permissions`（否则加载失败）
3. **Phase 2**：Trust Policy 在运行时根据 `source` + `permissions` 做访问控制：
   - `builtin`/`official` 插件：声明即授权
   - `community` 插件：高风险权限（`fs`/`network`/`env`）需用户确认
4. **Phase 3（T3）**：capability-based API，插件只能调用 manifest 中声明且被授权的能力

**Builtin Data Tools 注册**：

`createBuiltinDataTools()` 应在 `bootstrapKernel()` 阶段注册到全局 tool registry，统一前缀为 `kernel:*`（如 `kernel:state.get`、`kernel:record.search`）。当前只有定义和导出，没有注册调用。

---

### 3.4 未来规划：脚本沙箱

当前阶段通过用户确认降低风险。后续引入沙箱执行环境（如 isolated-vm 或 WebAssembly）：

- 社区插件脚本在沙箱内运行
- 限制文件系统访问、网络访问、`process.env` 访问
- 通过 capability-based API 授权（插件只能调用 manifest 中声明的能力）

### 3.5 Trust Policy 演进路径

```
当前（T1/T2）:  PermissiveTrustPolicy（内置插件全信任）
                + ScriptConfirmationGate（社区插件需用户确认加载）

Phase 1:        PermissionAwareTrustPolicy
                - manifest 声明 permissions → Trust Policy 在运行时校验
                - 未声明权限的高风险工具调用被拒绝

未来（T3）:     TieredTrustPolicy
                - builtin/official: 全部能力
                - community-confirmed: 受限能力（无 fs、无 network、无 env）
                - sandboxed: 最小能力（纯计算 + 声明式 proposal）
```

---

## 4. 网络安全（按层级）

### 4.1 T1 自部署

- **CORS**：`localhost` 硬编码可接受（用户自管网络环境）
- **HTTPS**：不强制（本机访问）
- **认证**：不需要（单用户）
- **`/debug` 页面**：通过 `ENABLE_DEBUG_PAGE=true` 环境变量开启，默认关闭

### 4.2 T2 Demo 托管

- **CORS**：通过 `CORS_ORIGIN` 环境变量配置允许的域
- **HTTPS**：强制
- **认证**：不需要（服务器无状态，无用户数据）
- **速率限制**：必须——防止 API 滥用（尤其是 `/actions` 会触发 LLM 调用消耗资源）
- **`/api/provider-keys`**：禁用
- **`/api/model-db/refresh`**：禁用或限制频率
- **`/debug` 页面**：禁用
- **`baseUrl` 白名单**：禁止自定义 `baseUrl`（防 SSRF），或限制为已知 Provider 域名

### 4.3 T3 商业化（未来）

- 在 T2 基础上增加：用户认证（JWT/OAuth）、数据隔离（row-level security）、API Key 配额管理、审计日志

---

## 5. 数据安全

### 5.1 客户端数据（T1/T2）

- 游戏数据存储在浏览器 IndexedDB（`@covel/store` IdbStore 后端）
- API Key 存储在 localStorage
- 不同用户（不同浏览器/设备）的数据天然隔离
- 用户可随时清除浏览器数据

### 5.2 服务端数据（T3 未来）

- PostgreSQL + Row-Level Security 实现用户间数据隔离
- API Key 加密存储（AES-256-GCM，密钥从用户密码派生或 KMS）
- 数据导出/删除 API（GDPR 合规预留）

---

## 6. `/debug` 页面

- **控制方式**：环境变量 `ENABLE_DEBUG_PAGE=true` 开启，默认 `false`
- **T1**：用户自行决定是否开启
- **T2/T3**：禁用（`DEPLOYMENT_TIER !== "self"` 时强制禁用，忽略 `ENABLE_DEBUG_PAGE`）
- **内容限制**：只展示当前 session 的 trace 事件，不支持跨 session 查询（T1 单用户场景无需额外限制，但架构上已做 session 隔离）

---

## 7. 错误信息策略

| 层级 | 客户端错误消息 | 服务端日志 |
|------|-------------|----------|
| T1 | 详细错误（含 provider 响应、模型名等，便于用户调试） | console（可选 pino） |
| T2 | 通用错误 + 错误码（不暴露 provider 细节） | 结构化日志（pino） |
| T3 | 通用错误 + 错误码 + 工单 ID | 结构化日志 + 审计追踪 |

---

## 8. 环境变量清单

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DEPLOYMENT_TIER` | `self` | 部署层级：`self` / `demo` / `commercial` |
| `CORS_ORIGIN` | `http://localhost:5173` | 允许的 CORS 来源（逗号分隔） |
| `ENABLE_DEBUG_PAGE` | `false` | 是否启用 `/debug` 页面 |
| `ENABLE_DEV_KEYS_ENDPOINT` | 由 `DEPLOYMENT_TIER` 决定 | 是否启用 `/api/provider-keys` |
| `RATE_LIMIT_RPM` | 无限制（T1）/ `60`（T2） | 每分钟请求上限 |
| `ALLOWED_BASE_URLS` | 无限制（T1）/ 已知 Provider 列表（T2） | 允许的自定义 Provider baseUrl |
