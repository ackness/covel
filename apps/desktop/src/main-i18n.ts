import { app } from "electron";
import fs from "node:fs";

export type DesktopLocale = "zh-CN" | "en-US";

type Messages = Record<string, string>;

const messages: Record<DesktopLocale, Messages> = {
  "en-US": {
    "startup.portConflict.title": "Port conflict",
    "startup.portConflict.hint":
      "Another process is using the required port. Close other Covel instances or restart your computer.",
    "startup.permissionDenied.title": "Permission denied",
    "startup.permissionDenied.hint":
      "Covel could not access a required directory. Check that the app has permission to write to its data folder.",
    "startup.timeout.title": "Server timed out",
    "startup.timeout.hint":
      "The backend took too long to boot. Check the logs. A missing llm.toml or slow disk can cause this.",
    "startup.missingFile.title": "Missing file",
    "startup.missingFile.hint":
      "A required bundled file is missing. The installation may be corrupt. Reinstall the app.",
    "startup.failed.title": "Startup failed",
    "startup.status.initializing": "Initializing...",
    "startup.status.loading": "Loading...",
    "startup.status.startingServer": "Starting server...",
    "startup.status.loadingPlugins": "Loading plugins...",
    "startup.status.initializingDatabase": "Initializing database...",
    "startup.status.almostReady": "Almost ready...",
    "startup.status.ready": "Ready!",
    "splash.retry": "Retry",
    "splash.viewLogs": "View Logs",
    "splash.openLogsFolder": "Open Logs Folder",
    "splash.openDataFolder": "Open Data Folder",
    "menu.about": "About Covel",
    "menu.settings": "Settings...",
    "menu.file": "File",
    "menu.newWorld": "New World",
    "menu.importPlugin": "Import Plugin...",
    "menu.importWorld": "Import World...",
    "menu.exportChat": "Export Chat...",
    "menu.edit": "Edit",
    "menu.view": "View",
    "menu.actualSize": "Actual Size",
    "menu.documentation": "Documentation",
    "menu.inspectElement": "Inspect Element",
    "dialog.open": "Open",
    "dialog.cancel": "Cancel",
    "dialog.externalLink.title": "Open external link?",
    "dialog.externalLink.message": "Open {host} in your browser?",
    "dialog.externalLink.detail":
      "{url}\n\nThis link uses unencrypted http. Only proceed if you trust the source.",
    "dialog.dataDir.title": "Choose Covel data directory",
    "dialog.importPlugin.title": "Import Plugin",
    "dialog.importWorld.title": "Import World Package",
    "dialog.filter.zipArchives": "Zip archives",
    "dialog.filter.allFiles": "All files",
    "import.cancelled": "Cancelled",
    "import.invalidPayload": "Invalid payload",
    "import.sourcePathRequired": "sourcePath must be a string",
    "import.noSourcePath": "No source path provided",
    "import.sourceMissing": "Source does not exist: {sourcePath}",
    "import.pluginMissingManifest": "Directory does not contain PLUGIN.md",
    "import.worldMissingManifest": "Directory does not contain world.yaml",
    "import.alreadyExists": "Already exists: {name}",
    "import.pluginZipMissingManifest": "Zip does not contain PLUGIN.md",
    "import.worldZipMissingManifest": "Zip does not contain world.yaml",
    "import.unsupportedSource":
      "Unsupported source (expected a folder or a .zip file)",
    "import.failedWithReason": "Import failed: {reason}",
  },
  "zh-CN": {
    "startup.portConflict.title": "端口冲突",
    "startup.portConflict.hint":
      "另一个进程正在使用所需端口。请关闭其他 Covel 实例，或重启电脑。",
    "startup.permissionDenied.title": "权限不足",
    "startup.permissionDenied.hint":
      "Covel 无法访问所需目录。请确认应用有权限写入数据文件夹。",
    "startup.timeout.title": "服务器启动超时",
    "startup.timeout.hint":
      "后端启动耗时过长。请检查日志。缺少 llm.toml 或磁盘较慢都可能导致这个问题。",
    "startup.missingFile.title": "缺少文件",
    "startup.missingFile.hint":
      "缺少必需的内置文件。当前安装可能已损坏，请重新安装应用。",
    "startup.failed.title": "启动失败",
    "startup.status.initializing": "正在初始化...",
    "startup.status.loading": "正在加载...",
    "startup.status.startingServer": "正在启动服务器...",
    "startup.status.loadingPlugins": "正在加载插件...",
    "startup.status.initializingDatabase": "正在初始化数据库...",
    "startup.status.almostReady": "即将完成...",
    "startup.status.ready": "准备就绪",
    "splash.retry": "重试",
    "splash.viewLogs": "查看日志",
    "splash.openLogsFolder": "打开日志文件夹",
    "splash.openDataFolder": "打开数据文件夹",
    "menu.about": "关于 Covel",
    "menu.settings": "设置...",
    "menu.file": "文件",
    "menu.newWorld": "新建世界",
    "menu.importPlugin": "导入插件...",
    "menu.importWorld": "导入世界...",
    "menu.exportChat": "导出聊天...",
    "menu.edit": "编辑",
    "menu.view": "视图",
    "menu.actualSize": "实际大小",
    "menu.documentation": "文档",
    "menu.inspectElement": "检查元素",
    "dialog.open": "打开",
    "dialog.cancel": "取消",
    "dialog.externalLink.title": "打开外部链接？",
    "dialog.externalLink.message": "在浏览器中打开 {host}？",
    "dialog.externalLink.detail":
      "{url}\n\n此链接使用未加密的 http。请只在信任来源时继续。",
    "dialog.dataDir.title": "选择 Covel 数据目录",
    "dialog.importPlugin.title": "导入插件",
    "dialog.importWorld.title": "导入世界包",
    "dialog.filter.zipArchives": "Zip 压缩包",
    "dialog.filter.allFiles": "所有文件",
    "import.cancelled": "已取消",
    "import.invalidPayload": "无效的请求内容",
    "import.sourcePathRequired": "sourcePath 必须是字符串",
    "import.noSourcePath": "未提供来源路径",
    "import.sourceMissing": "来源不存在：{sourcePath}",
    "import.pluginMissingManifest": "目录中没有 PLUGIN.md",
    "import.worldMissingManifest": "目录中没有 world.yaml",
    "import.alreadyExists": "已存在：{name}",
    "import.pluginZipMissingManifest": "Zip 中没有 PLUGIN.md",
    "import.worldZipMissingManifest": "Zip 中没有 world.yaml",
    "import.unsupportedSource": "不支持的来源，请选择文件夹或 .zip 文件",
    "import.failedWithReason": "导入失败：{reason}",
  },
};

let currentLocale: DesktopLocale = "en-US";

function normalizeLocale(value: unknown): DesktopLocale | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  if (normalized.startsWith("zh")) return "zh-CN";
  if (normalized.startsWith("en")) return "en-US";
  return null;
}

function readSettingsLocale(settingsJsonPath: string): DesktopLocale | null {
  try {
    if (!fs.existsSync(settingsJsonPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(settingsJsonPath, "utf-8")) as {
      entries?: Record<string, unknown>;
    };
    const entries = parsed.entries ?? {};
    const nestedUi = entries.ui as { locale?: unknown } | undefined;
    return (
      normalizeLocale(entries["ui.locale"]) ?? normalizeLocale(nestedUi?.locale)
    );
  } catch {
    return null;
  }
}

function systemLocale(): DesktopLocale {
  return normalizeLocale(app.getLocale()) ?? "en-US";
}

export function initDesktopI18n(settingsJsonPath: string): DesktopLocale {
  currentLocale = readSettingsLocale(settingsJsonPath) ?? systemLocale();
  return currentLocale;
}

export function setDesktopLocaleFromSettings(
  entries: Record<string, unknown>,
): DesktopLocale {
  const nestedUi = entries.ui as { locale?: unknown } | undefined;
  currentLocale =
    normalizeLocale(entries["ui.locale"]) ??
    normalizeLocale(nestedUi?.locale) ??
    currentLocale;
  return currentLocale;
}

export function getDesktopLocale(): DesktopLocale {
  return currentLocale;
}

export function t(
  key: string,
  params: Record<string, string | number> = {},
): string {
  const template =
    messages[currentLocale][key] ?? messages["en-US"][key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}
