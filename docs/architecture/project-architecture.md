# Covel 项目架构图

## 整体架构

```mermaid
graph TB
    subgraph 应用层[应用层 Apps]
        Web[apps/web<br/>React + Vite 前端]
        Runtime[apps/runtime<br/>Node.js 运行时后端]
    end

    subgraph 核心模块层[核心模块层 Modules]
        Contracts[modules/contracts<br/>契约与类型定义]
        Domain[modules/domain<br/>领域实体与仓储]
        ModelGateway[modules/model-gateway<br/>模型网关<br/>OpenAI/Anthropic/DashScope]
        Storage[modules/storage<br/>存储层<br/>PostgreSQL + 内存]
        CommandSystem[modules/command-system<br/>命令系统]
        FlowEngine[modules/flow-engine<br/>流程引擎]
        PackageRuntime[modules/package-runtime<br/>包运行时]
        Archive[modules/archive<br/>档案管理]
        MemoryRAG[modules/memory-rag<br/>记忆 RAG]
        Observability[modules/observability<br/>可观测性]
    end

    subgraph 扩展层[扩展层 Extensions]
        CoreArchive[core-archive<br/>档案扩展]
        CoreCharacterCard[core-character-card<br/>角色卡]
        CoreWorldbook[core-worldbook<br/>世界观]
        CorePersona[core-persona<br/>人设]
        CorePresets[core-presets<br/>预设]
        CoreMemoryRAG[core-memory-rag<br/>记忆 RAG]
        CoreDebug[core-debug-commands<br/>调试命令]
        CoreGuide[core-guide<br/>引导]
    end

    subgraph 基础设施[基础设施]
        PostgreSQL[(PostgreSQL<br/>持久化存储)]
        InMemory[(内存存储<br/>开发/测试)]
        ExternalAPI[外部 API<br/>OpenAI / Anthropic]
    end

    Web -->|HTTP/API| Runtime
    Web -->|使用| Contracts
    Runtime -->|依赖| Domain
    Runtime -->|调用| ModelGateway
    Runtime -->|读写| Storage
    Runtime -->|执行| CommandSystem
    Runtime -->|驱动| FlowEngine
    Runtime -->|加载| PackageRuntime
    Runtime -->|使用| Archive
    Runtime -->|调用| MemoryRAG
    Runtime -->|收集| Observability

    PackageRuntime -.->|加载| Extensions
    Extensions -.->|使用| CoreArchive
    Extensions -.->|使用| CoreCharacterCard
    Extensions -.->|使用| CoreWorldbook

    ModelGateway -->|调用| ExternalAPI
    Storage -->|连接| PostgreSQL
    Storage -->|使用| InMemory
```

## 架构分层说明

### 1. 应用层 (Apps)

| 组件 | 技术栈 | 职责 |
|------|--------|------|
| `apps/web` | React 19 + Vite | 三栏式工作区界面，连接管理、任务预设编辑 |
| `apps/runtime` | Node.js + TSX | 运行时服务器，编排所有模块 |

### 2. 核心模块层 (Modules)

| 模块 | 核心职责 |
|------|----------|
| `contracts` | 跨层共享的类型定义、Schema、Locale 支持 |
| `domain` | 领域实体（Story, Session, Turn）、仓储接口 |
| `model-gateway` | 模型能力抽象（text/object/stream/embed/image/speech），支持多提供商 |
| `storage` | 统一存储端口，支持 PostgreSQL 和内存实现 |
| `command-system` | 斜杠命令注册与执行 |
| `flow-engine` | 任务流程编排引擎 |
| `package-runtime` | 扩展包加载与生命周期管理 |
| `archive` | 档案版本管理与血缘追溯 |
| `memory-rag` | 记忆检索与向量存储 |
| `observability` | 日志、追踪、Langfuse 集成 |

### 3. 扩展层 (Extensions)

所有扩展都通过 `package-runtime` 加载，提供具体业务能力：

- **core-archive**: 档案相关功能
- **core-character-card**: 角色卡管理
- **core-worldbook**: 世界观设定
- **core-persona**: 角色人设
- **core-presets**: 任务预设
- **core-memory-rag**: 记忆增强生成
- **core-debug-commands**: 开发调试命令
- **core-guide**: 用户引导

## 关键依赖关系

```mermaid
flowchart LR
    subgraph 上层[上层]
        A[apps/web]
        B[apps/runtime]
        C[extensions/*]
    end

    subgraph 中层[中层 - 核心模块]
        D[model-gateway]
        E[command-system]
        F[storage]
        G[flow-engine]
        H[package-runtime]
    end

    subgraph 底层[底层 - 基础]
        I[contracts]
        J[domain]
    end

    A --> B
    B --> D
    B --> E
    B --> F
    B --> G
    B --> H
    C --> H
    D --> I
    E --> I
    F --> I
    G --> I
    H --> I
    D --> J
    E --> J
    F --> J
```

## 数据流

```mermaid
sequenceDiagram
    participant User as 用户
    participant Web as Web 前端
    participant Runtime as 运行时
    participant Gateway as Model Gateway
    participant Storage as 存储层
    participant External as 外部模型

    User->>Web: 输入指令
    Web->>Runtime: API 请求
    Runtime->>Storage: 加载上下文
    Runtime->>Gateway: 生成请求
    Gateway->>External: 调用模型
    External-->>Gateway: 返回流式响应
    Gateway-->>Runtime: 流式传递
    Runtime-->>Web: SSE 推送
    Runtime->>Storage: 保存结果
    Web-->>User: 显示输出
```

## 技术约束

- **国际化**: 默认 `zh-CN`，可选 `en`，通过 `Accept-Language` 和 action locale 字段传递
- **存储**: 接口统一，支持 PostgreSQL 生产环境和内存开发环境
- **模型调用**: 所有模型流量必须通过 `model-gateway`，禁止直接调用提供商 SDK
- **Monorepo**: pnpm workspace，Turbo 构建加速
