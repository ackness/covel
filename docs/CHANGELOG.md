# Changelog

All notable changes to this project will be documented in this file. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.1] - 2026-04-25

首个公开稳定版本。在 `0.0.1-beta` 基础上做了一轮可发布性收敛。

### Added
- 框架定位为 **agentic role-playing game framework**（README 中英文重写以体现这一定位）
- GitHub Actions release workflow 支持 `git push v*` tag 自动 build 并发布 GitHub Release
- Electron 打包产出收敛到「DMG + ZIP」两个文件，新增 `apps/desktop/scripts/cleanup-artifacts.mjs` 在 `afterAllArtifactBuild` 钩子里清理 blockmap、`latest-*.yml` 等 auto-update 元数据和解包目录
- create-plugin / create-world skill 增加测试与验证指引（`references/plugin-testing.md`、`references/world-validation.md`），含 vitest + MockLLM + harness 模板和 schema/引用一致性/lore 覆盖度脚本

### Changed
- monorepo 全量版本号 `0.0.1-beta` → `0.0.1`（root + 4 apps + 12 packages + 7 plugins + 2 templates + Tauri 3 处）
- `electron-builder.yml` 增加 `publish: null` 抑制 update manifest
- `docs/guide/plugin-authoring.md` 附录 B 插件清单按 `plugins/**/PLUGIN.md` 真实 frontmatter 重列（priority、runtime 类型与仓库实际一致）
- `docs/reference/plugins.md` 多 runtime 目录示例改为中性占位，避免与真实 `core-world-init/schema-gen` 单 runtime 现状混淆
- README/web 首页 demo 资源刷新为最新 dev 视频（3× 速、去音轨、800px GIF + 1280p MP4）

### Fixed
- `.claude/skills/create-plugin/references/example-plugins.md` 修正过时的 `model: ds`(实际 slot 为 `story` / `plugin`) 和与真实插件不符的 priority 数字

## [0.0.1-beta] - 2026-04-19

首个公开 beta 版本。

### Added
- 插件驱动的回合执行管线（Trigger Router → Priority Scheduler → Context Assembly → Runtime Runner → Commit Chain）
- 多 Provider LLM 抽象：DeepSeek / Qwen (DashScope) / OpenAI / Anthropic
- 2597 模型能力数据库（LiteLLM 同步），自动识别多模态 / function-calling / reasoning
- 存储后端：Memory / SQLite / IndexedDB / PostgreSQL（Drizzle ORM）
- 核心插件集：`core-pregame`、`core-world-init`、`core-char-creator`、`core-narrator`、`core-guide`、`core-npc-graph`、`core-codex`
- 声明式 UI：`json-render` + plugin-owned `ui/*.json`，无硬编码 Tab
- Electron 桌面版：macOS (arm64/x64)、Windows (x64/arm64 NSIS + portable)
- 外部化 prompt 模板与世界包（markdown + yaml）
- i18n：中英双语前端 + plugin 本地化 runtime
- 智能重试：超时 / 首 token 过慢 / 工具调用死循环 自动检测并回退
- 开发期 LLM replay cache（`COVEL_LLM_REPLAY=auto`）

### Documentation
- 项目 README、LICENSE (MIT)、CONTRIBUTING、CHANGELOG
- 三层文档：`reference/` (API/协议)、`guide/` (作者指南)、`architecture/` (系统设计)
- Release pipeline：`.github/workflows/release.yml`

[Unreleased]: https://github.com/AcKnEsS/covel/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.1
[0.0.1-beta]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.1-beta
