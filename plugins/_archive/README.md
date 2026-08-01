# \_archive

已退役插件的归档目录。`discoverPlugins` 只认 `plugins/<dir>/PLUGIN.md` 与 `plugins/<dir>/runtimes/*/PLUGIN.md`，本目录没有 PLUGIN.md，因此**不会被加载**；pnpm workspace 的 `plugins/*` glob 也不匹配嵌套目录，归档包不参与安装与测试。与 `worlds/_archive/` 同一约定。

| 插件              | 归档时间   | 原因                                                                                                                                                                                                                            |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `player-identity` | 2026-08-01 | 职责已被角色卡接管：口吻/persona 在创角时经世界 `characterAttributes` 写入角色卡，`{{ player.character }}` 注入叙事。`persona-provider` capability 口子保留（框架按 capability 发现，缺席时优雅降级），第三方插件仍可自行提供。 |

恢复方式：移回 `plugins/<id>/` 后执行 `pnpm install`（重新纳入 workspace），并跑 `pnpm validate:plugin plugins/<id>` 与全量 `pnpm lint`。
