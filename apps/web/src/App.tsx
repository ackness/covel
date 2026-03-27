import React from "react";

import { useI18n, type Locale } from "./i18n.js";
import { SessionWorkbench } from "./components/session-workbench.js";
import { WorkbenchLeftRail } from "./components/workbench-left-rail.js";
import { WorkbenchSidePanel } from "./components/workbench-side-panel.js";
import { useWorkbenchController } from "./use-workbench-controller.js";

export function App() {
  const {
    locale,
    setLocale,
    worlds,
    packages,
    presets,
    sessions,
    archives,
    guideStateRecords,
    traceEntries,
    workflowSnapshots,
    workspace,
    status,
    composer,
    worldName,
    worldDescription,
    selectedWorldId,
    selectedWorld,
    selectedSession,
    workbenchTitle,
    workbenchDescription,
    emptyTimelinePrompt,
    activeSessionPresetId,
    activeSessionPresetName,
    enabledPresets,
    sessionPresetOptions,
    newSessionPresetId,
    canSend,
    showSlashMenu,
    slashSuggestions,
    normalizedSlashSelectedIndex,
    composerRef,
    composerFormRef,
    pendingBlockRef,
    setWorldName,
    setWorldDescription,
    setSelectedWorldId,
    setNewSessionPresetId,
    handleCreateWorld,
    handleCreateStarterWorld,
    handleCreateSession,
    handleSendMessage,
    handleComposerChange,
    handleComposerKeyDown,
    applySlashCommandSelection,
    handleSessionPresetChange,
    handlePresetSave,
    handleBlockSelection,
    handleCreateArchive,
    handleRestoreArchive,
    handleSelectSession,
    setSelectedSession
  } = useWorkbenchController();
  const { t } = useI18n();

  return (
    <div className="page-shell">
      <header className="page-header">
        <div className="brand-stack">
          <div className="brand">covel</div>
          <div className="page-header-status">
            <div className="workspace-meta workspace-status">
              {status === "idle" ? t("app.status.idle") : t("app.status.streaming")}
            </div>
            {workspace.pendingBlock ? (
              <div className="workspace-meta workspace-status">{t("app.pendingBlock")}</div>
            ) : null}
          </div>
        </div>
        <div className="page-header-tools">
          <div className="locale-switcher" role="group" aria-label={t("app.localeLabel")}>
            <span className="workspace-meta locale-switcher-label">{t("app.localeLabel")}</span>
            <div className="locale-switcher-track">
              <button
                type="button"
                className={locale === "zh-CN" ? "locale-button active" : "locale-button"}
                aria-label={t("language.zh-CN")}
                aria-pressed={locale === "zh-CN"}
                onClick={() => setLocale("zh-CN" as Locale)}
              >
                中
              </button>
              <button
                type="button"
                className={locale === "en" ? "locale-button active" : "locale-button"}
                aria-label={t("language.en")}
                aria-pressed={locale === "en"}
                onClick={() => setLocale("en" as Locale)}
              >
                EN
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="page-content">
        <div className="workspace-shell">
          <aside className="workspace-panel panel-left" aria-label={t("app.worldNavigator")}>
            <WorkbenchLeftRail
              presets={presets}
              selectedWorldId={selectedWorldId}
              worldDescription={worldDescription}
              worldName={worldName}
              worlds={worlds}
              onPresetSave={(input) => void handlePresetSave(input)}
              onCreateStarterWorld={() => void handleCreateStarterWorld()}
              onCreateWorld={(event) => void handleCreateWorld(event)}
              onSelectWorld={setSelectedWorldId}
              onWorldDescriptionChange={setWorldDescription}
              onWorldNameChange={setWorldName}
            />
          </aside>

          <SessionWorkbench
            activeSessionPresetId={activeSessionPresetId}
            activeSessionPresetName={activeSessionPresetName}
            canSend={canSend}
            composer={composer}
            composerFormRef={composerFormRef}
            composerRef={composerRef}
            emptyTimelinePrompt={emptyTimelinePrompt}
            newSessionPresetId={newSessionPresetId}
            newSessionPresetOptions={enabledPresets}
            normalizedSlashSelectedIndex={normalizedSlashSelectedIndex}
            pendingBlockRef={pendingBlockRef}
            sessionPresetOptions={sessionPresetOptions}
            selectedSession={selectedSession}
            selectedWorld={selectedWorld}
            sessions={sessions}
            showSlashMenu={showSlashMenu}
            slashSuggestions={slashSuggestions}
            status={status}
            workbenchDescription={workbenchDescription}
            workbenchTitle={workbenchTitle}
            workspace={workspace}
            onBlockSelection={(optionId) => void handleBlockSelection(optionId)}
            onComposerChange={handleComposerChange}
            onComposerKeyDown={handleComposerKeyDown}
            onCreateArchive={() => void handleCreateArchive()}
            onCreateSession={() => void handleCreateSession()}
            onNewSessionPresetChange={setNewSessionPresetId}
            onSendMessage={(event) => void handleSendMessage(event)}
            onSessionPresetChange={(presetId) => void handleSessionPresetChange(presetId)}
            onSessionSelect={handleSelectSession}
            onSlashSelect={applySlashCommandSelection}
          />

          <aside className="workspace-panel panel-right" aria-label={t("app.contextPanel")}>
            <WorkbenchSidePanel
              activeSessionPresetId={activeSessionPresetId}
              archives={archives}
              guideStateRecords={guideStateRecords}
              packages={packages}
              presets={presets}
              selectedSession={selectedSession}
              selectedWorld={selectedWorld}
              sessions={sessions}
              status={status}
              traceEntries={traceEntries}
              traceId={workspace.lastTraceId}
              workflowSnapshots={workflowSnapshots}
              workspace={workspace}
              onRestoreArchive={(archiveVersionId) => void handleRestoreArchive(archiveVersionId)}
              onSessionSelect={setSelectedSession}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}
