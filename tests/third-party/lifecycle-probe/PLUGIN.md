---
name: lifecycle-probe
displayName: { zh: 插件生命周期测试, en: Plugin Lifecycle Probe }
description:
  zh: 独立第三方测试包，验证安装、审批、运行和卸载。
  en: Standalone third-party install, approval, runtime, and uninstall probe.
pluginType: plugin
entry: ./server/index.js
commands:
  - name: probe
    description: { zh: 查看插件测试状态, en: Show plugin probe status }
    action: probe-status
---

# Plugin Lifecycle Probe

Test-only package. Executable runtimes live under `runtimes/`.
