import React, { createContext, useContext, useEffect, useState } from "react";

export type Locale = "zh-CN" | "en";

type TranslationKey =
  | "app.archiveSummary"
  | "app.archiveWorkingSummary"
  | "app.archives"
  | "app.composer"
  | "app.createSession"
  | "app.createSnapshot"
  | "app.createStarterWorld"
  | "app.createWorld"
  | "app.emptySessionBody"
  | "app.emptySessionTitle"
  | "app.emptyTimelineTitle"
  | "app.emptyWorldBody"
  | "app.emptyWorldTitle"
  | "app.localeLabel"
  | "app.noSession"
  | "app.noSessionSelected"
  | "app.noTrace"
  | "app.notAvailable"
  | "app.packages"
  | "app.pendingBlock"
  | "app.restoreAsFork"
  | "app.role.assistant"
  | "app.role.user"
  | "app.send"
  | "app.session"
  | "app.sessionPreset"
  | "app.sessionPresetHint"
  | "app.sessions"
  | "app.sessionPresetUnbound"
  | "app.settingsDock"
  | "app.sessionStatus.active"
  | "app.sessionStatus.waiting_for_input"
  | "app.sessionStatus.unknown"
  | "app.status.idle"
  | "app.status.streaming"
  | "app.trace"
  | "app.newSessionPreset"
  | "app.worldPrimer"
  | "app.worldDescription"
  | "app.worldName"
  | "app.worlds"
  | "archive.restoreAsFork"
  | "archive.restoreInPlace"
  | "interactive.submitResponse"
  | "language.en"
  | "language.zh-CN"
  | "preset.baseUrl"
  | "preset.default"
  | "preset.defaultPreset"
  | "preset.disabled"
  | "preset.edit"
  | "preset.editAria"
  | "preset.enabled"
  | "preset.model"
  | "preset.presets"
  | "preset.save"
  | "trace.recent"
  | "trace.none"
  | "worlds.createWorld"
  | "worlds.openAria"
  | "worlds.worldDescription"
  | "worlds.worldName";

const messages: Record<Locale, Record<TranslationKey, string>> = {
  "zh-CN": {
    "app.archiveSummary": "归档摘要",
    "app.archiveWorkingSummary": "工作摘要",
    "app.archives": "归档",
    "app.composer": "输入",
    "app.createSession": "开始新会话",
    "app.createSnapshot": "创建快照",
    "app.createStarterWorld": "创建示例世界并开始",
    "app.createWorld": "创建世界",
    "app.emptySessionBody": "这个世界已经就绪，现在创建一个会话并发送第一句话。",
    "app.emptySessionTitle": "还没有会话",
    "app.emptyTimelineTitle": "发送第一条消息",
    "app.emptyWorldBody": "先生成一个示例世界，立刻进入可交互的试玩状态。",
    "app.emptyWorldTitle": "先创建一个世界",
    "app.localeLabel": "语言",
    "app.noSession": "无会话",
    "app.noSessionSelected": "未选择会话",
    "app.noTrace": "暂无追踪",
    "app.notAvailable": "不适用",
    "app.packages": "扩展包",
    "app.pendingBlock": "等待交互",
    "app.restoreAsFork": "以分支恢复",
    "app.role.assistant": "助手",
    "app.role.user": "你",
    "app.send": "发送",
    "app.session": "会话",
    "app.sessionPreset": "当前会话预设",
    "app.sessionPresetHint": "会话将始终通过这个预设调用模型，预设内部可以再定义自己的回退链。",
    "app.sessionPresetUnbound": "未绑定预设",
    "app.sessions": "会话列表",
    "app.settingsDock": "设置区",
    "app.sessionStatus.active": "进行中",
    "app.sessionStatus.waiting_for_input": "等待输入",
    "app.sessionStatus.unknown": "未知状态",
    "app.status.idle": "空闲",
    "app.status.streaming": "生成中",
    "app.trace": "追踪",
    "app.newSessionPreset": "新会话预设",
    "app.worldPrimer": "世界概览",
    "app.worldDescription": "世界描述",
    "app.worldName": "世界名称",
    "app.worlds": "世界",
    "archive.restoreAsFork": "作为分支恢复",
    "archive.restoreInPlace": "原地恢复",
    "interactive.submitResponse": "提交响应",
    "language.en": "English",
    "language.zh-CN": "中文",
    "preset.baseUrl": "基础 URL",
    "preset.default": "默认",
    "preset.defaultPreset": "默认预设",
    "preset.disabled": "已停用",
    "preset.edit": "编辑",
    "preset.editAria": "编辑 {name}",
    "preset.enabled": "已启用",
    "preset.model": "模型",
    "preset.presets": "预设",
    "preset.save": "保存预设",
    "trace.recent": "最近追踪",
    "trace.none": "暂无追踪",
    "worlds.createWorld": "创建世界",
    "worlds.openAria": "打开 {name}",
    "worlds.worldDescription": "世界描述",
    "worlds.worldName": "世界名称"
  },
  en: {
    "app.archiveSummary": "Archive summary",
    "app.archiveWorkingSummary": "Working summary",
    "app.archives": "Archives",
    "app.composer": "Composer",
    "app.createSession": "Start New Session",
    "app.createSnapshot": "Create Snapshot",
    "app.createStarterWorld": "Create Starter World",
    "app.createWorld": "Create World",
    "app.emptySessionBody": "This world is ready. Create a session and send the first line.",
    "app.emptySessionTitle": "No session yet",
    "app.emptyTimelineTitle": "Send the first line",
    "app.emptyWorldBody": "Spin up a starter world and drop straight into an interactive run.",
    "app.emptyWorldTitle": "Create a world first",
    "app.localeLabel": "Language",
    "app.noSession": "No session",
    "app.noSessionSelected": "No session selected",
    "app.noTrace": "No trace yet",
    "app.notAvailable": "n/a",
    "app.packages": "Packages",
    "app.pendingBlock": "Pending block",
    "app.restoreAsFork": "Restore As Fork",
    "app.role.assistant": "assistant",
    "app.role.user": "user",
    "app.send": "Send",
    "app.session": "Session",
    "app.sessionPreset": "Session preset",
    "app.sessionPresetHint": "This session always calls through the selected preset. The preset itself may define its own fallback chain.",
    "app.sessionPresetUnbound": "No preset bound",
    "app.sessions": "Sessions",
    "app.settingsDock": "Settings",
    "app.sessionStatus.active": "active",
    "app.sessionStatus.waiting_for_input": "waiting for input",
    "app.sessionStatus.unknown": "unknown",
    "app.status.idle": "Idle",
    "app.status.streaming": "Streaming",
    "app.trace": "Trace",
    "app.newSessionPreset": "New session preset",
    "app.worldPrimer": "World Primer",
    "app.worldDescription": "World Description",
    "app.worldName": "World Name",
    "app.worlds": "Worlds",
    "archive.restoreAsFork": "Restore as fork",
    "archive.restoreInPlace": "Restore in place",
    "interactive.submitResponse": "Submit response",
    "language.en": "English",
    "language.zh-CN": "中文",
    "preset.baseUrl": "Base URL",
    "preset.default": "Default",
    "preset.defaultPreset": "Default preset",
    "preset.disabled": "Disabled",
    "preset.edit": "Edit",
    "preset.editAria": "Edit {name}",
    "preset.enabled": "Enabled",
    "preset.model": "Model",
    "preset.presets": "Presets",
    "preset.save": "Save preset",
    "trace.recent": "Recent trace",
    "trace.none": "No trace",
    "worlds.createWorld": "Create world",
    "worlds.openAria": "Open {name}",
    "worlds.worldDescription": "World description",
    "worlds.worldName": "World name"
  }
};

const STORAGE_KEY = "covel.locale";
const DEFAULT_LOCALE: Locale = "zh-CN";

function normalizeLocale(value: string | null | undefined): Locale {
  return value === "en" ? "en" : DEFAULT_LOCALE;
}

export function getStoredLocale(): Locale {
  if (typeof window === "undefined") {
    return DEFAULT_LOCALE;
  }

  return normalizeLocale(window.localStorage.getItem(STORAGE_KEY));
}

function translate(locale: Locale, key: TranslationKey, values?: Record<string, string>): string {
  const template = messages[locale][key] ?? messages[DEFAULT_LOCALE][key];
  if (!values) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? `{${name}}`);
}

type I18nContextValue = {
  locale: Locale;
  setLocale(locale: Locale): void;
  t(key: TranslationKey, values?: Record<string, string>): string;
};

const defaultContextValue: I18nContextValue = {
  locale: DEFAULT_LOCALE,
  setLocale() {},
  t(key, values) {
    return translate(DEFAULT_LOCALE, key, values);
  }
};

const I18nContext = createContext<I18nContextValue>(defaultContextValue);

function resolveInitialLocale(initialLocale?: Locale): Locale {
  if (initialLocale) {
    return initialLocale;
  }

  if (typeof window === "undefined") {
    return DEFAULT_LOCALE;
  }

  return getStoredLocale();
}

export function persistLocale(locale: Locale) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, locale);
  document.documentElement.lang = locale;
}

export function I18nProvider(input: {
  children: React.ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocale] = useState<Locale>(() => resolveInitialLocale(input.initialLocale));

  useEffect(() => {
    persistLocale(locale);
  }, [locale]);

  return (
    <I18nContext.Provider
      value={{
        locale,
        setLocale,
        t(key, values) {
          return translate(locale, key, values);
        }
      }}
    >
      {input.children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
