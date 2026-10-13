import fs from "node:fs";
import {
  canonicalizeLocale,
  DEFAULT_FALLBACK_LOCALE,
  localeRegistry,
} from "@covel/shared";

export type DesktopLocale = string;

type Messages = Record<string, string>;

const messages: Readonly<Record<string, Messages | undefined>> = {
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
    "startup.status.copyingData": "Copying your data to the new location...",
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
    "dialog.ok": "OK",
    "dialog.externalLink.title": "Open external link?",
    "dialog.externalLink.message": "Open {host} in your browser?",
    "dialog.externalLink.detail":
      "{url}\n\nThis link uses unencrypted http. Only proceed if you trust the source.",
    "dialog.dataDir.title": "Choose Covel data directory",
    "dialog.dataDir.startEmpty": "Start empty",
    "dialog.dataDir.copy.message":
      "Copy your existing data to the new location?",
    "dialog.dataDir.copy.detail":
      "Current data: {from}\nNew location: {to}\n\nCopy my data: the next time Covel starts, it copies your saves and worlds to the new location and then switches to it. Nothing is moved or deleted in the current folder.\n\nStart empty: after a restart Covel uses the new location without your data. Your current data stays in the current folder.",
    "dialog.dataDir.copy.copy": "Copy my data",
    "dialog.dataDir.existing.message": "This folder already holds Covel data",
    "dialog.dataDir.existing.detail":
      "After a restart Covel uses the data in {to} as it is. Nothing is copied or overwritten. Your current data stays in {from}.",
    "dialog.dataDir.existing.use": "Use this folder",
    "dialog.dataDir.noCopy.message": "The new location starts empty",
    "dialog.dataDir.noCopy.detail":
      "Covel cannot copy your data to {to}. After a restart it starts empty there. Your current data stays in {from}. To bring it over, quit Covel and copy covel.db and the worlds folder yourself.",
    "dataCopy.copied.message": "Your data was copied",
    "dataCopy.copied.detail":
      "Covel now uses {to}. The old data is still in {from}. Delete it yourself when you no longer need it.",
    "dataCopy.used-existing.message": "Nothing was copied",
    "dataCopy.used-existing.detail":
      "{to} already holds Covel data, so Covel uses it as it is. Your old data is still in {from}.",
    "dataCopy.failed.message": "Your data was not copied",
    "dataCopy.failed.detail":
      "{reason}\n\nCovel keeps using {from}. Nothing was changed there. To try again, choose the folder again in Settings → Desktop.",
    "dataCopy.reason.in-use":
      "Another Covel process still has the database open. Quit Covel completely first.",
    "dataCopy.reason.interrupted":
      "The copy was cut short the last time Covel started. If {to} holds a covel.db or worlds folder from that copy, delete them before you choose this folder again.",
    "dialog.importPlugin.title": "Import Plugin",
    "dialog.importWorld.title": "Import World Package",
    "dialog.filter.zipArchives": "Zip archives",
    "dialog.filter.allFiles": "All files",
    "update.title": "Covel update available",
    "update.message": "Covel v{version} is available",
    "update.detail":
      "You are using v{currentVersion}. Open GitHub Releases to download the new version, or ignore this version.",
    "update.openRelease": "Open download page",
    "update.ignoreVersion": "Ignore this version",
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
    "startup.status.copyingData": "正在把数据复制到新位置...",
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
    "dialog.ok": "好",
    "dialog.externalLink.title": "打开外部链接？",
    "dialog.externalLink.message": "在浏览器中打开 {host}？",
    "dialog.externalLink.detail":
      "{url}\n\n此链接使用未加密的 http。请只在信任来源时继续。",
    "dialog.dataDir.title": "选择 Covel 数据目录",
    "dialog.dataDir.startEmpty": "从空目录开始",
    "dialog.dataDir.copy.message": "要把现有数据复制到新位置吗？",
    "dialog.dataDir.copy.detail":
      "当前数据：{from}\n新位置：{to}\n\n复制我的数据：下次启动 Covel 时，先把存档和世界复制到新位置，再切换过去。当前目录里的内容不会被移动或删除。\n\n从空目录开始：重启后 Covel 使用新位置，里面没有你的数据。现有数据留在当前目录。",
    "dialog.dataDir.copy.copy": "复制我的数据",
    "dialog.dataDir.existing.message": "这个目录里已经有 Covel 数据",
    "dialog.dataDir.existing.detail":
      "重启后 Covel 直接使用 {to} 里的数据，不复制也不覆盖任何文件。现有数据留在 {from}。",
    "dialog.dataDir.existing.use": "使用这个目录",
    "dialog.dataDir.noCopy.message": "新位置从空目录开始",
    "dialog.dataDir.noCopy.detail":
      "Covel 无法把数据复制到 {to}，重启后那里是空的。现有数据留在 {from}。想带过去的话，退出 Covel 后自己复制 covel.db 和 worlds 文件夹。",
    "dataCopy.copied.message": "数据已复制",
    "dataCopy.copied.detail":
      "Covel 现在使用 {to}。旧数据还在 {from}，不再需要时请自己删除。",
    "dataCopy.used-existing.message": "没有复制任何数据",
    "dataCopy.used-existing.detail":
      "{to} 里已经有 Covel 数据，Covel 直接使用它。旧数据还在 {from}。",
    "dataCopy.failed.message": "数据没有复制成功",
    "dataCopy.failed.detail":
      "{reason}\n\nCovel 继续使用 {from}，那里的内容没有任何改动。想再试一次，请在 设置 → 桌面 里重新选择目录。",
    "dataCopy.reason.in-use":
      "另一个 Covel 进程还开着数据库。请先完全退出 Covel。",
    "dataCopy.reason.interrupted":
      "上次启动时复制被中断了。如果 {to} 里留有那次复制的 covel.db 或 worlds 文件夹，请先删除再重新选择这个目录。",
    "dialog.importPlugin.title": "导入插件",
    "dialog.importWorld.title": "导入世界包",
    "dialog.filter.zipArchives": "Zip 压缩包",
    "dialog.filter.allFiles": "所有文件",
    "update.title": "Covel 有新版本",
    "update.message": "Covel v{version} 已发布",
    "update.detail":
      "当前版本为 v{currentVersion}。你可以前往 GitHub Releases 下载，或者忽略此版本。",
    "update.openRelease": "前往下载",
    "update.ignoreVersion": "忽略此版本",
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
  "ru-RU": {
    "startup.portConflict.title": "Конфликт портов",
    "startup.portConflict.hint":
      "Требуемый порт занят другим процессом. Закройте другие экземпляры Covel или перезагрузите компьютер.",
    "startup.permissionDenied.title": "Доступ запрещён",
    "startup.permissionDenied.hint":
      "Covel не удалось получить доступ к требуемой папке. Убедитесь, что у приложения есть разрешение на запись в папку данных.",
    "startup.timeout.title": "Истекло время ожидания сервера",
    "startup.timeout.hint":
      "Запуск серверной части занял слишком много времени. Проверьте журналы. Причиной может быть отсутствие llm.toml или медленная работа диска.",
    "startup.missingFile.title": "Файл не найден",
    "startup.missingFile.hint":
      "Отсутствует необходимый встроенный файл. Возможно, приложение установлено с ошибками. Переустановите его.",
    "startup.failed.title": "Не удалось запустить приложение",
    "startup.status.initializing": "Инициализация...",
    "startup.status.loading": "Загрузка...",
    "startup.status.startingServer": "Запуск сервера...",
    "startup.status.loadingPlugins": "Загрузка плагинов...",
    "startup.status.initializingDatabase": "Инициализация базы данных...",
    "startup.status.almostReady": "Почти готово...",
    "startup.status.ready": "Готово!",
    "startup.status.copyingData": "Копирование данных в новое расположение...",
    "splash.retry": "Повторить",
    "splash.viewLogs": "Просмотреть журналы",
    "splash.openLogsFolder": "Открыть папку журналов",
    "splash.openDataFolder": "Открыть папку данных",
    "menu.about": "О Covel",
    "menu.settings": "Настройки...",
    "menu.file": "Файл",
    "menu.newWorld": "Новый мир",
    "menu.importPlugin": "Импортировать плагин...",
    "menu.importWorld": "Импортировать мир...",
    "menu.exportChat": "Экспортировать чат...",
    "menu.edit": "Правка",
    "menu.view": "Вид",
    "menu.actualSize": "Фактический размер",
    "menu.documentation": "Документация",
    "menu.inspectElement": "Исследовать элемент",
    "dialog.open": "Открыть",
    "dialog.cancel": "Отмена",
    "dialog.ok": "ОК",
    "dialog.externalLink.title": "Открыть внешнюю ссылку?",
    "dialog.externalLink.message": "Открыть {host} в браузере?",
    "dialog.externalLink.detail":
      "{url}\n\nЭта ссылка использует незашифрованный протокол http. Продолжайте, только если доверяете источнику.",
    "dialog.dataDir.title": "Выберите папку данных Covel",
    "dialog.dataDir.startEmpty": "Начать с пустой папки",
    "dialog.dataDir.copy.message":
      "Скопировать существующие данные в новое расположение?",
    "dialog.dataDir.copy.detail":
      "Текущие данные: {from}\nНовое расположение: {to}\n\nСкопировать мои данные: при следующем запуске Covel скопирует сохранения и миры в новое расположение и затем переключится на него. В текущей папке ничего не перемещается и не удаляется.\n\nНачать с пустой папки: после перезапуска Covel будет использовать новое расположение без ваших данных. Текущие данные останутся в текущей папке.",
    "dialog.dataDir.copy.copy": "Скопировать мои данные",
    "dialog.dataDir.existing.message": "В этой папке уже есть данные Covel",
    "dialog.dataDir.existing.detail":
      "После перезапуска Covel будет использовать данные в {to} как есть. Ничего не копируется и не перезаписывается. Текущие данные останутся в {from}.",
    "dialog.dataDir.existing.use": "Использовать эту папку",
    "dialog.dataDir.noCopy.message": "Новое расположение будет пустым",
    "dialog.dataDir.noCopy.detail":
      "Covel не может скопировать данные в {to}. После перезапуска там будет пусто. Текущие данные останутся в {from}. Чтобы перенести их, закройте Covel и скопируйте covel.db и папку worlds самостоятельно.",
    "dataCopy.copied.message": "Данные скопированы",
    "dataCopy.copied.detail":
      "Covel теперь использует {to}. Старые данные остались в {from}. Удалите их сами, когда они больше не понадобятся.",
    "dataCopy.used-existing.message": "Ничего не скопировано",
    "dataCopy.used-existing.detail":
      "В {to} уже есть данные Covel, поэтому Covel использует их как есть. Старые данные остались в {from}.",
    "dataCopy.failed.message": "Данные не скопированы",
    "dataCopy.failed.detail":
      "{reason}\n\nCovel продолжает использовать {from}. Там ничего не изменилось. Чтобы повторить попытку, выберите папку снова в разделе «Настройки → Настольное приложение».",
    "dataCopy.reason.in-use":
      "Другой процесс Covel всё ещё держит базу данных открытой. Сначала полностью закройте Covel.",
    "dataCopy.reason.interrupted":
      "Копирование было прервано при прошлом запуске Covel. Если в {to} остались covel.db или папка worlds от этой копии, удалите их, прежде чем снова выбрать эту папку.",
    "dialog.importPlugin.title": "Импорт плагина",
    "dialog.importWorld.title": "Импорт пакета мира",
    "dialog.filter.zipArchives": "ZIP-архивы",
    "dialog.filter.allFiles": "Все файлы",
    "update.title": "Доступно обновление Covel",
    "update.message": "Доступна версия Covel {version}",
    "update.detail":
      "Вы используете версию {currentVersion}. Откройте страницу выпусков на GitHub, чтобы скачать новую версию, или пропустите это обновление.",
    "update.openRelease": "Открыть страницу загрузки",
    "update.ignoreVersion": "Пропустить эту версию",
    "import.cancelled": "Отменено",
    "import.invalidPayload": "Недопустимые данные",
    "import.sourcePathRequired": "sourcePath должен быть строкой",
    "import.noSourcePath": "Путь к источнику не указан",
    "import.sourceMissing": "Источник не существует: {sourcePath}",
    "import.pluginMissingManifest": "В папке отсутствует PLUGIN.md",
    "import.worldMissingManifest": "В папке отсутствует world.yaml",
    "import.alreadyExists": "Уже существует: {name}",
    "import.pluginZipMissingManifest": "В ZIP-архиве отсутствует PLUGIN.md",
    "import.worldZipMissingManifest": "В ZIP-архиве отсутствует world.yaml",
    "import.unsupportedSource":
      "Неподдерживаемый источник (ожидается папка или ZIP-файл)",
    "import.failedWithReason": "Не удалось импортировать: {reason}",
  },
};

let currentLocale: DesktopLocale = DEFAULT_FALLBACK_LOCALE;

export function normalizeDesktopLocale(value: unknown): DesktopLocale | null {
  if (typeof value !== "string") return null;
  const canonicalLocale = canonicalizeLocale(value);
  if (!canonicalLocale) return null;
  return localeRegistry.match(canonicalLocale)?.code ?? canonicalLocale;
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
      normalizeDesktopLocale(entries["ui.locale"]) ??
      normalizeDesktopLocale(nestedUi?.locale)
    );
  } catch {
    return null;
  }
}

export function initDesktopI18n(
  settingsJsonPath: string,
  systemLocale: unknown,
): DesktopLocale {
  currentLocale =
    readSettingsLocale(settingsJsonPath) ??
    normalizeDesktopLocale(systemLocale) ??
    DEFAULT_FALLBACK_LOCALE;
  return currentLocale;
}

export function setDesktopLocaleFromSettings(
  entries: Record<string, unknown>,
): DesktopLocale {
  const nestedUi = entries.ui as { locale?: unknown } | undefined;
  currentLocale =
    normalizeDesktopLocale(entries["ui.locale"]) ??
    normalizeDesktopLocale(nestedUi?.locale) ??
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
    messages[currentLocale]?.[key] ??
    messages[DEFAULT_FALLBACK_LOCALE]?.[key] ??
    key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}
