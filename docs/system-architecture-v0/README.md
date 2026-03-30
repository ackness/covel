# AI RPG 系统架构

时间：2026-03-29  
状态：草案

本目录包含一个主文档、两份配套规格和一份执行链流程图：

- [framework-architecture.md](/Users/wuyong/codes/game/covel-design/docs/architecture/2026-03-29_12-32_system-architecture-v2/framework-architecture.md)
- [runtime-kernel-spec.md](/Users/wuyong/codes/game/covel-design/docs/architecture/2026-03-29_12-32_system-architecture-v2/runtime-kernel-spec.md)
- [public-plugin-api-spec.md](/Users/wuyong/codes/game/covel-design/docs/architecture/2026-03-29_12-32_system-architecture-v2/public-plugin-api-spec.md)
- [execution-flow.md](/Users/wuyong/codes/game/covel-design/docs/architecture/2026-03-29_12-32_system-architecture-v2/execution-flow.md)

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

关系：

- `framework-architecture.md` 负责全局系统视角，单独阅读也应成立
- `execution-flow.md` 负责可视化执行链全貌，包含核心流程图和并行调度示意
- `runtime-kernel-spec.md` 负责内核执行链和模块边界
- `public-plugin-api-spec.md` 负责插件公开契约
- `contracts/` 和 `schemas/` 负责把文档中的关键边界转成可落地的契约入口
