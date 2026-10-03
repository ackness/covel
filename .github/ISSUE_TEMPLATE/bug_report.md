---
name: Bug report · 缺陷报告
about: Report a reproducible bug / 报告一个可复现的缺陷
title: "[Bug] "
labels: bug
---

<!--
Fill in either language. You can delete the section you don't use.
A problem inside a community plugin or world belongs in that package's own repository.
可以使用任一语言。删除你不用的那一段即可。
社区插件或社区世界内部的问题，请提到对应包的仓库。
-->

## Environment / 环境

- Covel version / 版本：<!-- e.g. v0.0.45, or a commit SHA when running from source -->
- How you run it / 运行方式：<!-- desktop macOS arm64 / desktop Windows x64 / source (pnpm dev) / Docker -->
- Storage / 存储：<!-- desktop default (SQLite) / sqlite / pg / memory -->
- World and play pack / 世界与玩法组合：<!-- e.g. Mistport + traditional story -->
- Community plugins installed / 已安装的社区插件：<!-- name + version, or "none" -->
- Provider + model per role / 各模型用途的服务商与模型：<!-- e.g. story: deepseek / deepseek-flash -->
- Node.js (source only / 仅源码运行)：<!-- node -v -->

## Steps to reproduce / 复现步骤

1.
2.
3.

## Expected behavior / 期望结果

<!-- What you expected to happen / 期望看到什么 -->

## Actual behavior / 实际结果

<!-- What actually happened, and whether it happens every time. / 实际看到什么，是否每次都出现 -->

## Logs / screenshots / 相关日志与截图

<!--
Remove API keys and personal content before pasting.
- Desktop: Settings → Desktop → "Open logs folder" (default ~/.covel/data/logs/: server.log, desktop.log)
- Source: the terminal output of `pnpm dev`
- A failed turn: open /debug, find the turn in the Trace Inspector, and attach the failing runtime or event
粘贴前请去掉 API key 和个人内容。
- 桌面版：设置 → 桌面 → “打开日志目录”（默认 ~/.covel/data/logs/：server.log、desktop.log）
- 源码运行：`pnpm dev` 的终端输出
- 某个回合出错：打开 /debug，在 Trace Inspector 中找到该回合，附上出错的 runtime 或事件
-->
