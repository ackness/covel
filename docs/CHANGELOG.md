# Changelog

All notable changes to this project will be documented in this file. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/AcKnEsS/covel/compare/v0.0.1-beta...HEAD
[0.0.1-beta]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.1-beta
