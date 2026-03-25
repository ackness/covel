import { startTransition, useEffect, useState } from "react";

import {
  createArchive,
  createWorld,
  listArchives,
  listMessages,
  listPackages,
  listSessions,
  listTraces,
  listWorlds,
  restoreArchive,
  sendMessage,
  submitBlockResponse
} from "./api.js";
import { TraceSummary } from "./components/trace-summary.js";
import { PresetEditor } from "./components/preset-editor.js";
import { useI18n, type Locale } from "./i18n.js";
import { applySseEvent, createInitialWorkspaceState, timelineFromMessages } from "./state.js";
import type { ArchiveRecord, SessionRecord, TraceRecord, WorldRecord, WorkspaceState } from "./types.js";

export function App() {
  const { locale, setLocale, t } = useI18n();
  const [worlds, setWorlds] = useState<WorldRecord[]>([]);
  const [packages, setPackages] = useState<Array<{ name: string; enabled: boolean }>>([]);
  const [selectedWorldId, setSelectedWorldId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [selectedSession, setSelectedSession] = useState<SessionRecord | null>(null);
  const [archives, setArchives] = useState<ArchiveRecord[]>([]);
  const [traceEntries, setTraceEntries] = useState<TraceRecord[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceState>(createInitialWorkspaceState());
  const [composer, setComposer] = useState("");
  const [worldName, setWorldName] = useState("");
  const [worldDescription, setWorldDescription] = useState("");
  const [status, setStatus] = useState<"idle" | "streaming">("idle");

  useEffect(() => {
    void loadInitialData();
  }, []);

  useEffect(() => {
    if (!selectedWorldId) {
      return;
    }

    void loadSessionsForWorld(selectedWorldId);
  }, [selectedWorldId]);

  useEffect(() => {
    if (!selectedSession) {
      return;
    }

    void loadSessionData(selectedSession.id);
  }, [selectedSession?.id]);

  useEffect(() => {
    if (!workspace.lastTraceId) {
      setTraceEntries([]);
      return;
    }

    void loadTraceEntries(workspace.lastTraceId);
  }, [workspace.lastTraceId]);

  async function loadInitialData() {
    const [loadedWorlds, loadedPackages] = await Promise.all([
      listWorlds(),
      listPackages()
    ]);

    startTransition(() => {
      setWorlds(loadedWorlds);
      setPackages(loadedPackages);
      setSelectedWorldId((current) => current ?? loadedWorlds[0]?.id ?? null);
    });
  }

  async function loadSessionsForWorld(worldId: string) {
    const loadedSessions = await listSessions(worldId);
    startTransition(() => {
      setSessions(loadedSessions);
      setSelectedSession((current) => {
        if (current && loadedSessions.some((session) => session.id === current.id)) {
          return current;
        }
        return loadedSessions[0] ?? null;
      });
    });
  }

  async function loadSessionData(sessionId: string) {
    const [messages, archiveRecords] = await Promise.all([
      listMessages(sessionId),
      listArchives(sessionId)
    ]);

    startTransition(() => {
      setWorkspace({
        timeline: timelineFromMessages(messages),
        pendingBlock: null,
        lastTraceId: null
      });
      setArchives(archiveRecords);
    });
  }

  async function loadTraceEntries(traceId: string) {
    const entries = await listTraces(traceId);
    startTransition(() => {
      setTraceEntries(entries);
    });
  }

  async function handleCreateWorld(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const world = await createWorld({
      name: worldName,
      description: worldDescription
    });

    startTransition(() => {
      setWorlds((current) => [...current, world]);
      setWorldName("");
      setWorldDescription("");
    });
  }

  async function handleSendMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSession || composer.trim().length === 0) {
      return;
    }

    setStatus("streaming");
    const events = await sendMessage({
      sessionId: selectedSession.id,
      content: composer
    });
    setComposer("");

    startTransition(() => {
      setWorkspace((current) => {
        let nextState = current;
        for (const nextEvent of events) {
          nextState = applySseEvent(nextState, nextEvent);
        }
        return nextState;
      });
      setStatus("idle");
    });
  }

  async function handleBlockSelection(optionId: string) {
    if (!selectedSession || !workspace.pendingBlock) {
      return;
    }

    const events = await submitBlockResponse({
      sessionId: selectedSession.id,
      response: {
        blockId: workspace.pendingBlock.id,
        blockType: workspace.pendingBlock.type,
        sessionId: selectedSession.id,
        turnId: workspace.pendingBlock.meta.turnId,
        response: {
          selected: optionId
        }
      }
    });

    startTransition(() => {
      let nextState: WorkspaceState = {
        ...workspace,
        pendingBlock: null
      };
      for (const nextEvent of events) {
        nextState = applySseEvent(nextState, nextEvent);
      }
      setWorkspace(nextState);
    });
  }

  async function handleCreateArchive() {
    if (!selectedSession) {
      return;
    }

    const snapshot = await createArchive({
      sessionId: selectedSession.id,
      turnCutoff: workspace.timeline.length,
      stateSnapshot: {
        timelineCount: workspace.timeline.length
      },
      workingSummary: t("app.archiveWorkingSummary"),
      archiveSummary: t("app.archiveSummary")
    });

    startTransition(() => {
      setArchives((current) => [...current, snapshot.version]);
    });
  }

  async function handleRestoreArchive(archiveVersionId: string) {
    const result = await restoreArchive({
      archiveVersionId,
      mode: "restore-as-fork"
    });

    startTransition(() => {
      setSelectedSession(result.session);
    });
  }

  function formatSessionStatus(value: string | null | undefined): string {
    if (value === "active") {
      return t("app.sessionStatus.active");
    }

    if (value === "waiting_for_input") {
      return t("app.sessionStatus.waiting_for_input");
    }

    if (!value) {
      return t("app.notAvailable");
    }

    return value;
  }

  function formatTimelineRole(role: "assistant" | "user"): string {
    return role === "assistant" ? t("app.role.assistant") : t("app.role.user");
  }

  function formatStatusLabel(value: "idle" | "streaming"): string {
    return value === "idle" ? t("app.status.idle") : t("app.status.streaming");
  }

  return (
    <div className="page-shell">
      <header className="page-header">
        <div>
          <div className="brand">covel</div>
          <div className="workspace-meta">{selectedSession?.id ?? t("app.noSession")}</div>
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
          <aside className="workspace-panel panel-left">
            <div className="panel-section">
              <div className="eyebrow">{t("app.worlds")}</div>
              <ul className="stack-list">
                {worlds.map((world) => (
                  <li key={world.id}>
                    <button
                      className={world.id === selectedWorldId ? "list-button active" : "list-button"}
                      onClick={() => setSelectedWorldId(world.id)}
                    >
                      <span>{world.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <form className="panel-section form-stack" onSubmit={handleCreateWorld}>
              <div className="eyebrow">{t("app.createWorld")}</div>
              <label className="field">
                <span>{t("app.worldName")}</span>
                <input
                  aria-label={t("app.worldName")}
                  value={worldName}
                  onChange={(event) => setWorldName(event.currentTarget.value)}
                />
              </label>
              <label className="field">
                <span>{t("app.worldDescription")}</span>
                <textarea
                  aria-label={t("app.worldDescription")}
                  value={worldDescription}
                  onChange={(event) => setWorldDescription(event.currentTarget.value)}
                />
              </label>
              <button type="submit" className="primary-button">{t("app.createWorld")}</button>
            </form>

            <div className="panel-section">
              <div className="eyebrow">{t("app.packages")}</div>
              <ul className="stack-list">
                {packages.map((pkg) => (
                  <li key={pkg.name} className="package-row">
                    <span>{pkg.name}</span>
                    <span>{pkg.enabled ? t("preset.enabled") : t("preset.disabled")}</span>
                  </li>
                ))}
              </ul>
            </div>

            <PresetEditor runtimeBaseUrl="" />
          </aside>

          <main className="workspace-main">
            <section className="timeline">
              {workspace.timeline.map((item) => (
                <article key={item.id} className={`message message-${item.role}`}>
                  <div className="message-role">{formatTimelineRole(item.role)}</div>
                  <div>{item.content}</div>
                </article>
              ))}
            </section>

            {workspace.pendingBlock ? (
              <section className="pending-block">
                <div className="eyebrow">{workspace.pendingBlock.type}</div>
                <h3>{String((workspace.pendingBlock.data as { title?: string }).title ?? t("app.pendingBlock"))}</h3>
                <div className="choice-grid">
                  {((workspace.pendingBlock.data as { options?: Array<{ id: string; label: string }> }).options ?? []).map((option) => (
                    <button
                      key={option.id}
                      className="choice-button"
                      onClick={() => handleBlockSelection(option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            <form className="composer" onSubmit={handleSendMessage}>
              <label className="field composer-field">
                <span>{t("app.composer")}</span>
                <textarea
                  aria-label={t("app.composer")}
                  value={composer}
                  onChange={(event) => setComposer(event.currentTarget.value)}
                />
              </label>
              <button type="submit" className="primary-button">{t("app.send")}</button>
            </form>
          </main>

          <aside className="workspace-panel panel-right">
            <div className="panel-section">
              <div className="eyebrow">{t("app.session")}</div>
              <div className="session-card">
                <div>{selectedSession?.id ?? t("app.noSessionSelected")}</div>
                <div>{formatSessionStatus(selectedSession?.status)}</div>
              </div>
            </div>

            <div className="panel-section">
              <div className="eyebrow">{t("app.archives")}</div>
              <button className="primary-button" onClick={handleCreateArchive}>{t("app.createSnapshot")}</button>
              <ul className="stack-list">
                {archives.map((archive) => (
                  <li key={archive.id} className="archive-row">
                    <span>{archive.id}</span>
                    <button className="secondary-button" onClick={() => handleRestoreArchive(archive.id)}>
                      {t("app.restoreAsFork")}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="panel-section">
              <TraceSummary traceId={workspace.lastTraceId} entries={traceEntries} />
            </div>
          </aside>
        </div>
      </div>

      <footer className="page-footer">
        <div className="page-footer-dock">
          <span className="eyebrow">{t("app.settingsDock")}</span>
        </div>
        <div className="page-footer-tools">
          <div className="workspace-meta workspace-status">{formatStatusLabel(status)}</div>
        </div>
      </footer>
    </div>
  );
}
