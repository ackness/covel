# Electron-only 一键重载配置方案

> 目标：在当前阶段只为 **Electron 桌面端** 提供“一键重载 / 应用配置变更”能力；Tauri、Web、自部署远端暂不提供。
>
> 本方案是低风险 MVP：复用现有 Electron IPC 重启 sidecar，不做真正的运行时热替换。

## 背景

当前 Covel 的很多配置是在 server sidecar 启动时读取并固化到内存对象中的：

- `~/.covel/llm.toml` → `createAiStack()` 启动时读取，生成 provider / preset / slot / gateway。
- `~/.covel/keys.env` → Electron 启动 sidecar 前合并到 child env；server 也在启动时读取。
- `~/.covel/config.toml` → Electron main 启动时解析路径，尤其是 `data_root`。
- `~/.covel/plugins/` → `bootstrapApi()` 启动时 discover / load manifests / tools / rpc / hooks。

因此，当前最稳妥的“一键重载”语义不是无重启热替换，而是：

```text
停止 Electron sidecar → 重新读取 ~/.covel 配置并启动 sidecar → 等待 /api/health → 刷新 renderer
```

现有代码已经具备主要能力：

- Electron main：`apps/desktop/src/main.ts`
  - IPC handler：`covel:restart-server`
- Web bridge：`apps/web/src/lib/desktop-bridge.ts`
  - `reloadServerAndWait()`
- UI：`apps/web/src/settings/DesktopPane.tsx`
  - 已有后端重启按钮
- 插件安装 UI：`apps/web/src/settings/panes/PackagesPane.tsx`
  - 插件安装后已有 restartRequired 提示和重启按钮

## 范围

### 本阶段支持

只支持 Electron：

| 环境 | 是否展示一键重载 |
| --- | --- |
| Electron | 是 |
| Tauri | 否 |
| Web dev / 浏览器 | 否 |
| 远端 self-host / commercial web | 否 |

### 本阶段不支持

暂不做以下能力：

- 不做 `llm.toml` 进程内热替换。
- 不做 plugin registry / tools / rpc / hooks 进程内热替换。
- 不提供远端 HTTP 重启 server API。
- 不为 Tauri 实现 restart sidecar command。
- 不 watch `~/.covel/` 文件变更自动 reload。

## 用户语义

建议按钮文案使用：

```text
应用配置变更
```

或英文：

```text
Apply config changes
```

说明文案：

```text
重启本地 Electron 后端并刷新界面。编辑 llm.toml、keys.env、config.toml 或安装插件后请点击此按钮。
```

英文：

```text
Restart the local Electron backend and refresh the app. Use this after editing llm.toml, keys.env, config.toml, or installing plugins.
```

## 预期行为

点击“一键重载”后：

1. Renderer 调用 `reloadServerAndWait()`。
2. `reloadServerAndWait()` 检查 `window.covelIpc`。
3. 通过 IPC 调用 `covel:restart-server`。
4. Electron main 停止当前 server sidecar。
5. Electron main 重新执行 `startServer(paths)`。
6. sidecar 重新读取：
   - `.env` / `.env.llm`（dev）
   - `~/.covel/keys.env`
   - `~/.covel/llm.toml`
   - `~/.covel/config.toml` 中的路径配置（由 Electron paths 初始化阶段决定；见注意事项）
   - `~/.covel/plugins/`
7. Electron main 等待 `/api/health` 成功。
8. Renderer 执行 `window.location.reload()`。
9. 前端 boot 重新拉取 `/api/presets`、`/api/packages`、`/api/llm-config` 等。

## 关键实现点

### 1. Electron-only 判断

当前有两个判断函数：

```ts
isDesktopApp()
hasElectronIpc()
```

本方案必须使用：

```ts
hasElectronIpc()
```

原因：

- `isDesktopApp()` 包含 Electron、Tauri、REST desktop-capable。
- 当前只想 Electron 提供一键重载。
- `reloadServerAndWait()` 本身也只在有 Electron IPC 时真正执行，否则返回 `false`。

## 修改清单

### 必改文件

```text
apps/web/src/settings/DesktopPane.tsx
apps/web/src/settings/panes/PackagesPane.tsx
apps/web/src/i18n/locales/zh-CN.json
apps/web/src/i18n/locales/en-US.json
```

### 可选文件

```text
apps/web/src/settings/panes/LlmKeysPane.tsx
apps/web/src/settings/panes/LlmSlotsPane.tsx
apps/web/src/lib/desktop-bridge.ts
```

## 详细改法

### 1. `DesktopPane.tsx`

文件：

```text
apps/web/src/settings/DesktopPane.tsx
```

当前已经 import：

```ts
hasElectronIpc,
reloadServerAndWait,
```

在组件内部增加：

```ts
const canReloadBackend = hasElectronIpc();
```

推荐修改 `handleRestart()`：

```ts
async function handleRestart() {
  if (!canReloadBackend) {
    setToast(t("settings.desktopRestartElectronOnly", "This action is only available in Electron."));
    setTimeout(() => setToast(null), 3000);
    return;
  }

  setBusy("restart");
  try {
    await reloadServerAndWait({
      message: t("reload.reloadingServer", "Restarting backend…"),
    });
  } catch (err) {
    setToast(err instanceof Error ? err.message : "Restart failed");
    setBusy(null);
    setTimeout(() => setToast(null), 3000);
  }
}
```

将原来的重启按钮改成只在 Electron 下展示：

```tsx
{canReloadBackend && (
  <Button
    size="sm"
    variant="outline"
    onClick={handleRestart}
    disabled={busy !== null}
  >
    {busy === "restart" ? (
      <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
    ) : (
      <RotateCw className="w-3 h-3 mr-1.5" />
    )}
    {t("settings.desktopApplyConfigChanges", "Apply config changes")}
  </Button>
)}
```

同时将 server 区域说明文案对应 i18n key 调整为“应用配置变更”语义。

### 2. `PackagesPane.tsx`

文件：

```text
apps/web/src/settings/panes/PackagesPane.tsx
```

当前 import：

```ts
import { isDesktopApp, reloadServerAndWait } from "@/lib/desktop-bridge.js";
```

改为：

```ts
import { hasElectronIpc, reloadServerAndWait } from "@/lib/desktop-bridge.js";
```

把：

```tsx
{isDesktopApp() && (
```

改为：

```tsx
{hasElectronIpc() && (
```

这样插件安装后的重启按钮只会在 Electron 里出现。

### 3. i18n 文案

文件：

```text
apps/web/src/i18n/locales/zh-CN.json
apps/web/src/i18n/locales/en-US.json
```

建议新增或替换以下 key。

中文：

```json
{
  "settings": {
    "desktopApplyConfigChanges": "应用配置变更",
    "desktopRestartElectronOnly": "此操作仅在 Electron 桌面端可用",
    "desktopRestartHint": "重启本地 Electron 后端并刷新界面。编辑 llm.toml、keys.env、config.toml 或安装插件后请点击此按钮。"
  }
}
```

英文：

```json
{
  "settings": {
    "desktopApplyConfigChanges": "Apply config changes",
    "desktopRestartElectronOnly": "This action is only available in Electron.",
    "desktopRestartHint": "Restart the local Electron backend and refresh the app. Use this after editing llm.toml, keys.env, config.toml, or installing plugins."
  }
}
```

## 可选增强：LLM 页面快捷入口

如果希望用户编辑 `llm.toml` 后不用切到 Desktop tab，可在 LLM 相关 pane 加快捷按钮。

推荐位置：

```text
apps/web/src/settings/panes/LlmKeysPane.tsx
```

新增 import：

```ts
import { FolderOpen, Info, RotateCw } from "lucide-react";
import {
  hasElectronIpc,
  isDesktopApp,
  openLlmToml,
  reloadServerAndWait,
} from "@/lib/desktop-bridge.js";
```

在 `Open llm.toml` 附近增加：

```tsx
{hasElectronIpc() && (
  <Button
    size="sm"
    variant="outline"
    onClick={() => {
      void reloadServerAndWait({
        message: t("reload.reloadingServer", "Restarting backend…"),
      }).catch((err: unknown) => {
        console.error("[LlmKeysPane] reload failed", err);
      });
    }}
    className="text-[11px]"
  >
    <RotateCw className="w-3 h-3 mr-1.5" />
    {t("settings.desktopApplyConfigChanges", "Apply config changes")}
  </Button>
)}
```

这个增强是可选项，不影响 MVP。

## 可选增强：bridge helper

当前可以直接用 `hasElectronIpc()`。如果希望语义更明确，可以在：

```text
apps/web/src/lib/desktop-bridge.ts
```

新增：

```ts
export function canReloadBackend(): boolean {
  return hasElectronIpc();
}
```

UI 使用：

```ts
canReloadBackend()
```

但这不是必须改动。

## 注意事项

### `config.toml:data_root`

`data_root` 是 Electron main 在启动阶段解析的路径。当前“一键重载”重启的是 sidecar server，不一定重新执行 Electron main 的完整 `ensureUserPaths()` 初始化逻辑。

因此：

- 如果用户通过现有 UI `pickDataDir()` 修改 data_root，该路径由 Electron main 写入 `config.toml`，当前代码提示“Restart the app to apply”。
- 若只重启 sidecar 而不重启 Electron main，是否能完整应用新的 `data_root` 取决于 `paths` 对象是否重新计算。
- 本方案建议文案中保守表达：编辑 `config.toml` 后点击可重启后端，但 `data_root` 这类路径变更必要时仍提示重启应用。

如果要让 data_root 也通过“一键重载”可靠生效，需要单独改 Electron main，使 `covel:restart-server` 在重启前重新执行 `ensureUserPaths()` 并更新 IPC info 中的 paths。这不属于本阶段最小改动。

### Tauri 暂不处理

Tauri 没有 `window.covelIpc`，因此：

- `hasElectronIpc()` 返回 false。
- 按钮不展示。
- 不需要新增 Tauri command。

### Web 端不提供 server restart API

不要为了 Web 添加：

```http
POST /api/config/restart
```

原因：

- 远端部署里这是高风险管理能力。
- 需要鉴权、CSRF、防误触和部署编排支持。
- 当前需求明确只支持 Electron。

## 验收标准

1. Electron 桌面端：
   - Settings → Desktop → Server 区域显示“应用配置变更”按钮。
   - 点击后出现 reload overlay。
   - sidecar 重启成功后前端刷新。
   - 修改 `llm.toml` 后点击按钮，`/api/llm-config` 和 `/api/presets` 反映新配置。
   - 安装插件后 Packages pane 的重启按钮可用。

2. 非 Electron：
   - Tauri / Web 中不显示“一键重载”按钮。
   - `PackagesPane` 中插件安装后的重启按钮不显示。
   - 不新增可被远端调用的重启 API。

3. 回归：
   - `pnpm lint` 通过。
   - Electron dev 下 `pnpm dev:electron` 可启动并重启 sidecar。

## 后续路线

本阶段之后，如果需要真正热重载，可另开方案：

1. `keys.env` live reload。
2. `llm.toml` 进程内 reload。
3. plugin manifest / UI reload。
4. plugin tools / hooks / rpc / handler 完整热替换。

这些都需要 server 侧架构改造，不建议混入本次 Electron-only MVP。

---

## 实施记录（2026-04-29）

### 已完成

按方案"必改文件"全部落地，修改 4 个文件：

| 文件 | 改动 |
| --- | --- |
| `apps/web/src/settings/DesktopPane.tsx` | `handleRestart()` 入口先用 `hasElectronIpc()` 守卫，非 Electron 弹 toast 提示；重启按钮整体改为 `hasElectronIpc()` 条件渲染；按钮文案 i18n key 从 `desktopRestart` 切换为 `desktopApplyConfigChanges` |
| `apps/web/src/settings/panes/PackagesPane.tsx` | import 从 `isDesktopApp` 改为 `hasElectronIpc`；插件安装后"需要重启"提示里的按钮判断条件同步切换 |
| `apps/web/src/i18n/locales/zh-CN.json` | 新增 `desktopApplyConfigChanges`、`desktopRestartElectronOnly`；重写 `desktopRestartHint` 文案强调"调试插件代码 / 提示词 / UI / 模型配置"场景 |
| `apps/web/src/i18n/locales/en-US.json` | 同上，英文 |

### 与原方案的偏差

1. **保留 `desktopRestart` 旧 key**：原方案建议"替换"，实施时为避免破坏其他可能引用此 key 的位置（grep 未发现，但保险起见），采取**新增** `desktopApplyConfigChanges` 的方式，旧 key 暂留待后续清理确认。
2. **`handleRestart` 不再依赖 `reloadServerAndWait` 的返回值判断**：方案示例代码保留 `if (!ok)` 分支用于 web 提示，但当前已通过 `hasElectronIpc()` 提前 return，`reloadServerAndWait` 在 Electron 内只会成功或抛错，不会返回 `false`，因此简化掉了 `desktopRestartWebHint` 分支。
3. **`desktopRestartHint` 文案更新**：原方案建议提示文案聚焦"重启本地后端"，实施时按用户实际场景（"调试插件代码 / 插件提示词 / 插件 UI / 添加修改模型"）调整，明确列出会被重新加载的范围。

### 未做（原因）

- ❌ **可选增强：`LlmKeysPane` 快捷入口** —— 当前用户可在"模型 / Slots"区域编辑后切到"桌面"tab 重启，操作路径不算长；等真出现频繁切 tab 的痛点再加。
- ❌ **可选增强：`bridge.canReloadBackend()` helper** —— `hasElectronIpc()` 命名已经足够清晰，再包一层属于过度设计。
- ❌ **i18n `desktopRestartHint` 用旧 key + 同时新增 `desktopApplyConfigChangesHint`** —— 直接复用 `desktopRestartHint` 改写文案最简，避免 i18n key 数量膨胀。
- ❌ **Tauri 适配** —— 用户明确仅 Electron。`hasElectronIpc()` 在 Tauri 下返回 false，按钮自动隐藏，符合预期。
- ❌ **真正的热替换 / `~/.covel/` 文件 watch 自动重启** —— 范围外，列入"后续路线"。
- ❌ **`config.toml: data_root` 通过此按钮生效** —— 涉及 Electron main 重新执行 `ensureUserPaths()`，超出 sidecar 重启范围，需单独改 main 进程，未在本次实施。

### 验收记录

- ✅ `pnpm --filter @covel/web exec tsc --noEmit` 通过。
- ✅ Web preview（`isDesktop=false`）下 Settings dialog 正常打开，PackagesPane 渲染无 runtime 错误，控制台无报错。
- ⏳ Electron 端实测（需 `pnpm dev:electron` 启动后人工验证按钮可见性 + 真重启 sidecar）—— 留给后续手动验证或 E2E 补充。
