# AI RPG 系统架构

时间：2026-03-29  
状态：草案

本目录包含一个主文档、两份配套规格、一份执行链流程图和一份部署安全模型：

- [framework-architecture.md](framework-architecture.md)
- [runtime-kernel-spec.md](runtime-kernel-spec.md)
- [public-plugin-api-spec.md](public-plugin-api-spec.md)
- [execution-flow.md](execution-flow.md)
- [deployment-security-model.md](deployment-security-model.md)

并补了两组契约骨架：

- `contracts/`：TypeScript 类型骨架
- `schemas/`：JSON Schema 数据合同

当前契约已覆盖：

- `plugin manifest`
- `runtime spec`
- `world package`
- `runtime settings`
- `runtime trigger / interval / manual`

阅读顺序：

1. `framework-architecture.md`
2. `execution-flow.md`
3. `runtime-kernel-spec.md`
4. `public-plugin-api-spec.md`
5. `deployment-security-model.md`（部署层级 T1/T2/T3、API Key 安全模型、插件安全模型）

关系：

- `framework-architecture.md` 负责全局系统视角，单独阅读也应成立
- `execution-flow.md` 负责可视化执行链全貌，包含核心流程图和并行调度示意
- `runtime-kernel-spec.md` 负责内核执行链和模块边界
- `public-plugin-api-spec.md` 负责插件公开契约
- `contracts/` 和 `schemas/` 负责把文档中的关键边界转成可落地的契约入口
