# 桌面版配置与数据目录

适用于 [`apps/desktop/`](../../apps/desktop/)（Electron）与 [`apps/desktop-tauri/`](../../apps/desktop-tauri/)（Tauri）两种桌面壳。两者共享同一个 Node sidecar，配置与数据布局完全一致。

## 目录结构

桌面版首次启动会自动创建 `~/.covel/`。配置小文件放这里，数据和日志默认放 `~/.covel/data/`。两者可通过 `config.toml` 解耦 —— 想把庞大的 SQLite 搬到外置硬盘，改一行即可。

```
~/.covel/                    ← 配置根（小文件，随应用版本稳定）
  config.toml                ← 数据位置指针 + 日志轮转参数（见下文）
  llm.toml                   ← LLM slot 配置（provider / model / baseUrl）
  keys.env                   ← provider API key，KEY=VALUE 纯文本
  plugins/                   ← 用户插件（和 app bundle 内的核心插件合并）

<data_root>/                 ← 默认 ~/.covel/data；可改到任意路径
  covel.db                   ← SQLite 数据库
  worlds/                    ← 用户创建的世界
  logs/                      ← 应用日志（自动轮转）
    tauri-main*.log          ← Tauri 主进程
    electron-*.log           ← Electron 主进程
    server-*.log             ← Node 后端（pino-roll）
  server.port                ← 最近一次启动的端口（诊断用）
```

## `~/.covel/config.toml`

首次启动自带注释模板。字段：

```toml
[paths]
# 数据目录。相对路径相对于本文件所在目录；绝对路径直接使用。
# 默认：~/.covel/data
# data_root = "/Volumes/External/covel-data"

[logging]
# 单个日志文件上限（MB），超过后轮转
max_size_mb = 10
# 保留的轮转文件数，超出后丢弃最旧一份。总磁盘占用 ≈ max_size_mb × max_files
max_files   = 10
```

改完要重启 Covel 生效。**改 `data_root` 不会搬旧数据** —— 新位置是空的，老数据留在原处你自己处理。

## `~/.covel/keys.env`

```env
# 一行一个 KEY=VALUE，# 开头是注释
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxx
OPENAI_API_KEY=sk-xxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx
```

server 会按 `*_API_KEY` 扫描所有条目注入 provider 运行时。Key 名 = provider 名全大写 + `_API_KEY`。文件权限默认 `0600`，app 保存时会重置；手动编辑后注意别改得太宽。

## `~/.covel/llm.toml`

见仓库根 [`llm.toml.example`](../../llm.toml.example) 示例；每个 slot 对应一个 provider / 模型组合。app 自带兜底 `story` slot 指向 DeepSeek —— 填好 `keys.env` 的 `DEEPSEEK_API_KEY` 就能跑。

## 前端入口

**Settings → Desktop** tab 暴露所有路径、一键打开目录、切换 `data_root`。不想改文件就在 UI 里点。

## 相关文档

- [README · 快速开始](../../README.md#-快速开始) — 下载与首次启动
- [apps/desktop/PACKAGING.md](../../apps/desktop/PACKAGING.md) — 桌面版本地构建、签名、公证
- [reference/api.md](../reference/api.md) — 后端 API 参考
