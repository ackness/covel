import React, { createContext, useContext, useEffect, useState } from "react";

export type Locale = "zh-CN" | "en";

type TranslationKey =
  | "app.archiveSummary"
  | "app.archiveWorkingSummary"
  | "app.activeWorkspace"
  | "app.archives"
  | "app.composer"
  | "app.commandSuggestions"
  | "app.contextPanel"
  | "app.contextPanelSummary"
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
  | "app.sessionControls"
  | "app.sessionPreset"
  | "app.sessionPresetHint"
  | "app.sessions"
  | "app.sessionPresetUnbound"
  | "app.settingsDock"
  | "app.sessionStatus.active"
  | "app.sessionStatus.waiting_for_input"
  | "app.sessionStatus.unknown"
  | "app.status.idle"
  | "app.statusLabel"
  | "app.status.streaming"
  | "app.trace"
  | "app.worldNavigator"
  | "app.worldNavigatorSummary"
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
  | "runtime.activity"
  | "runtime.workflow"
  | "runtime.statePatch"
  | "runtime.artifacts"
  | "runtime.noWorkflow"
  | "runtime.noStatePatch"
  | "runtime.noArtifact"
  | "runtime.status.suspended"
  | "runtime.status.running"
  | "runtime.status.completed"
  | "sidePanel.characters"
  | "sidePanel.charactersEmpty"
  | "sidePanel.debug"
  | "sidePanel.debugSummary"
  | "sidePanel.events"
  | "sidePanel.eventsEmpty"
  | "sidePanel.guideTopic"
  | "sidePanel.guideLatestChoice"
  | "sidePanel.guideStateEmpty"
  | "sidePanel.guideUpdatedAt"
  | "sidePanel.packages"
  | "sidePanel.packagesEmpty"
  | "sidePanel.pendingInteraction"
  | "sidePanel.quests"
  | "sidePanel.session"
  | "sidePanel.sessionSummary"
  | "sidePanel.settings"
  | "sidePanel.settingsSummary"
  | "sidePanel.traceCount"
  | "sidePanel.world"
  | "sidePanel.worldSummary"
  | "sidePanel.workflowSnapshots"
  | "sidePanel.workflowSnapshotsEmpty"
  | "worlds.createWorld"
  | "worlds.openAria"
  | "worlds.worldDescription"
  | "worlds.worldName";

const messages: Record<Locale, Record<TranslationKey, string>> = {
  "zh-CN": {
    "app.archiveSummary": "归档摘要",
    "app.archiveWorkingSummary": "工作摘要",
    "app.activeWorkspace": "当前工作区",
    "app.archives": "归档",
    "app.composer": "输入",
    "app.commandSuggestions": "命令建议",
    "app.contextPanel": "上下文与调试",
    "app.contextPanelSummary": "右侧只保留当前会话、世界上下文和运行诊断。",
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
    "app.sessionControls": "会话控制",
    "app.sessionPreset": "当前会话预设",
    "app.sessionPresetHint": "会话将始终通过这个预设调用模型，预设内部可以再定义自己的回退链。",
    "app.sessionPresetUnbound": "未绑定预设",
    "app.sessions": "会话列表",
    "app.settingsDock": "设置区",
    "app.sessionStatus.active": "进行中",
    "app.sessionStatus.waiting_for_input": "等待输入",
    "app.sessionStatus.unknown": "未知状态",
    "app.status.idle": "空闲",
    "app.statusLabel": "状态",
    "app.status.streaming": "生成中",
    "app.trace": "追踪",
    "app.worldNavigator": "世界导航",
    "app.worldNavigatorSummary": "先选择一个世界，再在中栏继续当前会话或创建新的入口。",
    "app.newSessionPreset": "新会话预设",
    "app.worldPrimer": "当前世界",
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
    "runtime.activity": "运行时活动",
    "runtime.workflow": "工作流",
    "runtime.statePatch": "状态变更",
    "runtime.artifacts": "工件",
    "runtime.noWorkflow": "暂无工作流状态",
    "runtime.noStatePatch": "暂无状态变更",
    "runtime.noArtifact": "暂无工件更新",
    "runtime.status.suspended": "已挂起",
    "runtime.status.running": "运行中",
    "runtime.status.completed": "已完成",
    "sidePanel.characters": "角色",
    "sidePanel.charactersEmpty": "还没有结构化角色数据。当前由 core-character-card 提供角色连续性约束，后续角色资产或记忆写入后会出现在这里。",
    "sidePanel.debug": "调试",
    "sidePanel.debugSummary": "追踪、工作流和最近运行时活动。",
    "sidePanel.events": "事件",
    "sidePanel.eventsEmpty": "还没有可展示的事件流。",
    "sidePanel.guideTopic": "主题",
    "sidePanel.guideLatestChoice": "最近引导选择",
    "sidePanel.guideStateEmpty": "当前还没有 guide 状态记录。",
    "sidePanel.guideUpdatedAt": "更新时间",
    "sidePanel.packages": "扩展",
    "sidePanel.packagesEmpty": "当前没有可展示的扩展信息。",
    "sidePanel.pendingInteraction": "等待交互",
    "sidePanel.quests": "任务",
    "sidePanel.session": "会话",
    "sidePanel.sessionSummary": "会话、快照与预设绑定。",
    "sidePanel.settings": "设置",
    "sidePanel.settingsSummary": "语言、模型预设和运行状态。",
    "sidePanel.traceCount": "追踪条目",
    "sidePanel.world": "世界",
    "sidePanel.worldSummary": "当前世界概览与会话上下文。",
    "sidePanel.workflowSnapshots": "工作流快照",
    "sidePanel.workflowSnapshotsEmpty": "当前没有持久化工作流快照。",
    "worlds.createWorld": "创建世界",
    "worlds.openAria": "打开 {name}",
    "worlds.worldDescription": "世界描述",
    "worlds.worldName": "世界名称"
  },
  en: {
    "app.archiveSummary": "Archive summary",
    "app.archiveWorkingSummary": "Working summary",
    "app.activeWorkspace": "Active workspace",
    "app.archives": "Archives",
    "app.composer": "Composer",
    "app.commandSuggestions": "Command suggestions",
    "app.contextPanel": "Context and debug",
    "app.contextPanelSummary": "Keep session context, world state, and runtime diagnostics on the right.",
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
    "app.sessionControls": "Session controls",
    "app.sessionPreset": "Session preset",
    "app.sessionPresetHint": "This session always calls through the selected preset. The preset itself may define its own fallback chain.",
    "app.sessionPresetUnbound": "No preset bound",
    "app.sessions": "Sessions",
    "app.settingsDock": "Settings",
    "app.sessionStatus.active": "active",
    "app.sessionStatus.waiting_for_input": "waiting for input",
    "app.sessionStatus.unknown": "unknown",
    "app.status.idle": "Idle",
    "app.statusLabel": "Status",
    "app.status.streaming": "Streaming",
    "app.trace": "Trace",
    "app.worldNavigator": "World navigator",
    "app.worldNavigatorSummary": "Pick a world first, then continue the active session or open a new one in the main workspace.",
    "app.newSessionPreset": "New session preset",
    "app.worldPrimer": "Current world",
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
    "runtime.activity": "Runtime Activity",
    "runtime.workflow": "Workflow",
    "runtime.statePatch": "State Patches",
    "runtime.artifacts": "Artifacts",
    "runtime.noWorkflow": "No workflow activity yet",
    "runtime.noStatePatch": "No state patches yet",
    "runtime.noArtifact": "No artifact updates yet",
    "runtime.status.suspended": "suspended",
    "runtime.status.running": "running",
    "runtime.status.completed": "completed",
    "sidePanel.characters": "Characters",
    "sidePanel.charactersEmpty": "No structured character data yet. core-character-card is still providing continuity guidance, and character assets or memory writes will appear here later.",
    "sidePanel.debug": "Debug",
    "sidePanel.debugSummary": "Trace, workflow, and recent runtime activity.",
    "sidePanel.events": "Events",
    "sidePanel.eventsEmpty": "No event stream to show yet.",
    "sidePanel.guideTopic": "Topic",
    "sidePanel.guideLatestChoice": "Latest guide choice",
    "sidePanel.guideStateEmpty": "No persisted guide state yet.",
    "sidePanel.guideUpdatedAt": "Updated",
    "sidePanel.packages": "Packages",
    "sidePanel.packagesEmpty": "No package information to show.",
    "sidePanel.pendingInteraction": "Pending interaction",
    "sidePanel.quests": "Quests",
    "sidePanel.session": "Session",
    "sidePanel.sessionSummary": "Session, snapshots, and preset bindings.",
    "sidePanel.settings": "Settings",
    "sidePanel.settingsSummary": "Locale, model presets, and runtime status.",
    "sidePanel.traceCount": "Trace entries",
    "sidePanel.world": "World",
    "sidePanel.worldSummary": "Current world overview and session context.",
    "sidePanel.workflowSnapshots": "Workflow snapshots",
    "sidePanel.workflowSnapshotsEmpty": "No persisted workflow snapshots yet.",
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
