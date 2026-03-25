import { startTransition, useEffect, useState } from "react";

import {
  createArchive,
  createSession,
  createWorld,
  listArchives,
  listMessages,
  listPackages,
  listPresets,
  listSessions,
  listTraces,
  listWorlds,
  restoreArchive,
  sendMessage,
  submitBlockResponse,
  updateSession
} from "./api.js";
import { BlockRenderer } from "./block-renderer-registry.js";
import { TraceSummary } from "./components/trace-summary.js";
import { PresetEditor } from "./components/preset-editor.js";
import { useI18n, type Locale } from "./i18n.js";
import { applySseEvent, createInitialWorkspaceState, timelineFromMessages } from "./state.js";
import type { ArchiveRecord, PresetSummary, SessionRecord, TraceRecord, WorldRecord, WorkspaceState } from "./types.js";
import { STORY_NARRATION_TASK } from "../../../modules/domain/src/index.js";

const STARTER_WORLD_BY_LOCALE: Record<Locale, {
  name: string;
  description: string;
  opener: string;
}> = {
  "zh-CN": {
    name: "雾港十三号",
    description: "风暴带边缘的浮桥城，灯塔靠鲸油与旧算法维持夜航，帮派、船团与失控遗物在潮雾里彼此试探。",
    opener: "我刚抵达雾港十三号的北栈桥，先告诉我眼前最值得注意的三件事。"
  },
  en: {
    name: "Mistharbor XIII",
    description: "A storm-belt port of floating piers where the lighthouse runs on whale oil and obsolete code, and every faction watches the fog for contraband relics.",
    opener: "I have just arrived at the north pier of Mistharbor XIII. Tell me the three most important things in front of me."
  }
};

function createOptimisticUserMessage(content: string) {
  return {
    id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role: "user" as const,
    content,
    streaming: false
  };
}

function createOpeningPrompt(worldName: string, locale: Locale): string {
  return locale === "en"
    ? `I have just entered ${worldName}. Sketch the opening scene in three sharp details.`
    : `我刚进入${worldName}，请先用三个清晰细节铺开开场场景。`;
}

function resolveSessionPresetId(session: SessionRecord | null, defaultPresetId: string): string {
  return session?.taskBindings?.[STORY_NARRATION_TASK] ?? session?.presetId ?? defaultPresetId;
}

export function App() {
  const { locale, setLocale, t } = useI18n();
  const [worlds, setWorlds] = useState<WorldRecord[]>([]);
  const [packages, setPackages] = useState<Array<{ name: string; enabled: boolean }>>([]);
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [selectedWorldId, setSelectedWorldId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [selectedSession, setSelectedSession] = useState<SessionRecord | null>(null);
  const [archives, setArchives] = useState<ArchiveRecord[]>([]);
  const [traceEntries, setTraceEntries] = useState<TraceRecord[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceState>(createInitialWorkspaceState());
  const [composer, setComposer] = useState("");
  const [worldName, setWorldName] = useState("");
  const [worldDescription, setWorldDescription] = useState("");
  const [newSessionPresetId, setNewSessionPresetId] = useState("");
  const [status, setStatus] = useState<"idle" | "streaming">("idle");
  const starterWorld = STARTER_WORLD_BY_LOCALE[locale];
  const selectedWorld = worlds.find((world) => world.id === selectedWorldId) ?? null;
  const defaultPresetId = presets.find((preset) => preset.isDefault)?.id ?? presets[0]?.id ?? "";
  const activeSessionPresetId = resolveSessionPresetId(selectedSession, defaultPresetId);
  const canSend = Boolean(selectedSession) && composer.trim().length > 0 && status !== "streaming";
  const enabledPresets = presets.filter((preset) => preset.enabled);

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
    const [loadedWorlds, loadedPackages, loadedPresets] = await Promise.all([
      listWorlds(),
      listPackages(),
      listPresets()
    ]);

    startTransition(() => {
      setWorlds(loadedWorlds);
      setPackages(loadedPackages);
      setPresets(loadedPresets);
      setNewSessionPresetId((current) => {
        if (current) {
          return current;
        }

        return loadedPresets.find((preset) => preset.isDefault)?.id ?? loadedPresets[0]?.id ?? "";
      });
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
      if (loadedSessions.length === 0) {
        setWorkspace(createInitialWorkspaceState());
        setArchives([]);
        setTraceEntries([]);
      }
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
    await createWorldAndSession({
      name: worldName.trim() || starterWorld.name,
      description: worldDescription.trim() || starterWorld.description,
      composerSeed: createOpeningPrompt(worldName.trim() || starterWorld.name, locale)
    });
  }

  async function createWorldAndSession(input: {
    name: string;
    description: string;
    composerSeed: string;
  }) {
    const world = await createWorld({
      name: input.name,
      description: input.description
    });
    const session = await createSession({
      worldId: world.id,
      taskBindings: {
        [STORY_NARRATION_TASK]: newSessionPresetId || defaultPresetId
      }
    });
    startTransition(() => {
      setWorlds((current) => [...current, world]);
      setSelectedWorldId(world.id);
      setSessions([session]);
      setSelectedSession(session);
      setWorkspace(createInitialWorkspaceState());
      setArchives([]);
      setTraceEntries([]);
      setComposer(input.composerSeed);
      setWorldName("");
      setWorldDescription("");
    });
  }

  async function handleCreateStarterWorld() {
    await createWorldAndSession({
      name: starterWorld.name,
      description: starterWorld.description,
      composerSeed: starterWorld.opener
    });
  }

  async function handleCreateSession() {
    if (!selectedWorldId) {
      return;
    }

    const session = await createSession({
      worldId: selectedWorldId,
      taskBindings: {
        [STORY_NARRATION_TASK]: newSessionPresetId || defaultPresetId
      }
    });
    const loadedSessions = await listSessions(selectedWorldId);

    startTransition(() => {
      setSessions(loadedSessions);
      setSelectedSession(session);
      setWorkspace(createInitialWorkspaceState());
      setArchives([]);
      setTraceEntries([]);
      setComposer(createOpeningPrompt(selectedWorld?.name ?? starterWorld.name, locale));
    });
  }

  async function handleSendMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = composer.trim();
    if (!selectedSession || content.length === 0) {
      return;
    }

    setStatus("streaming");
    startTransition(() => {
      setComposer("");
      setWorkspace((current) => ({
        ...current,
        timeline: [...current.timeline, createOptimisticUserMessage(content)]
      }));
    });

    try {
      const events = await sendMessage({
        sessionId: selectedSession.id,
        content
      });

      startTransition(() => {
        setWorkspace((current) => {
          let nextState = current;
          for (const nextEvent of events) {
            nextState = applySseEvent(nextState, nextEvent);
          }
          return nextState;
        });
      });
    } finally {
      startTransition(() => {
        setStatus("idle");
      });
    }
  }

  async function handleSessionPresetChange(presetId: string) {
    if (!selectedSession || presetId.length === 0 || presetId === resolveSessionPresetId(selectedSession, defaultPresetId)) {
      return;
    }

    const updatedSession = await updateSession({
      sessionId: selectedSession.id,
      taskBindings: {
        ...(selectedSession.taskBindings ?? {}),
        [STORY_NARRATION_TASK]: presetId
      },
      presetId
    });

    startTransition(() => {
      setSessions((current) =>
        current.map((session) => (session.id === updatedSession.id ? updatedSession : session))
      );
      setSelectedSession(updatedSession);
    });
  }

  async function handleBlockSelection(optionId: string) {
    if (!selectedSession || !workspace.pendingBlock) {
      return;
    }

    setStatus("streaming");

    try {
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
        setWorkspace((current) => {
          let nextState: WorkspaceState = {
            ...current,
            pendingBlock: null
          };
          for (const nextEvent of events) {
            nextState = applySseEvent(nextState, nextEvent);
          }
          return nextState;
        });
      });
    } finally {
      startTransition(() => {
        setStatus("idle");
      });
    }
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
    const loadedSessions = await listSessions(result.session.worldId);

    startTransition(() => {
      setSelectedWorldId(result.session.worldId);
      setSessions(loadedSessions);
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

  function formatPresetName(presetId: string | null | undefined): string {
    if (!presetId) {
      return t("app.sessionPresetUnbound");
    }

    return presets.find((preset) => preset.id === presetId)?.name ?? presetId;
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
              <div className="button-row">
                <button type="submit" className="primary-button">{t("app.createWorld")}</button>
                <button type="button" className="secondary-button" onClick={() => void handleCreateStarterWorld()}>
                  {t("app.createStarterWorld")}
                </button>
              </div>
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
            <section className="workspace-hero">
              <div className="eyebrow">{t("app.worldPrimer")}</div>
              <h1 className="hero-title">{selectedWorld?.name ?? starterWorld.name}</h1>
              <p className="hero-copy">{selectedWorld?.description ?? starterWorld.description}</p>
              {selectedSession ? (
                <div className="hero-actions">
                  <button type="button" className="secondary-button" onClick={() => void handleCreateSession()}>
                    {t("app.createSession")}
                  </button>
                  <span className="workspace-meta hero-meta">{formatPresetName(activeSessionPresetId)}</span>
                </div>
              ) : null}
            </section>

            {selectedSession ? (
              <>
                <section className="timeline">
                  {workspace.timeline.length > 0 ? workspace.timeline.map((item) => (
                    <article key={item.id} className={`message message-${item.role}`}>
                      <div className="message-role">{formatTimelineRole(item.role)}</div>
                      <div>{item.content}</div>
                    </article>
                  )) : (
                    <div className="timeline-empty">
                      <div className="eyebrow">{t("app.emptyTimelineTitle")}</div>
                      <p className="empty-copy">{createOpeningPrompt(selectedWorld?.name ?? starterWorld.name, locale)}</p>
                    </div>
                  )}
                </section>

                {workspace.pendingBlock ? (
                  <section className="pending-block">
                    <div className="eyebrow">{workspace.pendingBlock.type}</div>
                    <BlockRenderer
                      block={workspace.pendingBlock}
                      onChoiceSelect={(optionId) => void handleBlockSelection(optionId)}
                    />
                  </section>
                ) : null}

                <form className="composer" onSubmit={handleSendMessage}>
                  <label className="field composer-field">
                    <span>{t("app.composer")}</span>
                    <textarea
                      aria-label={t("app.composer")}
                      value={composer}
                      onChange={(event) => setComposer(event.currentTarget.value)}
                      disabled={status === "streaming"}
                    />
                  </label>
                  <button type="submit" className="primary-button" disabled={!canSend}>{t("app.send")}</button>
                </form>
              </>
            ) : (
              <section className="timeline-empty">
                <div className="eyebrow">{selectedWorld ? t("app.emptySessionTitle") : t("app.emptyWorldTitle")}</div>
                <p className="empty-copy">{selectedWorld ? t("app.emptySessionBody") : t("app.emptyWorldBody")}</p>
                <div className="hero-actions">
                  {selectedWorld ? (
                    <button type="button" className="primary-button" onClick={() => void handleCreateSession()}>
                      {t("app.createSession")}
                    </button>
                  ) : (
                    <button type="button" className="primary-button" onClick={() => void handleCreateStarterWorld()}>
                      {t("app.createStarterWorld")}
                    </button>
                  )}
                </div>
              </section>
            )}
          </main>

          <aside className="workspace-panel panel-right">
            <div className="panel-section">
              <div className="eyebrow">{t("app.session")}</div>
              <div className="session-card">
                <div className="session-summary">
                  <div>{selectedSession?.id ?? t("app.noSessionSelected")}</div>
                  <div className="workspace-meta">{formatPresetName(activeSessionPresetId)}</div>
                </div>
                <div>{formatSessionStatus(selectedSession?.status)}</div>
              </div>
              <label className="field">
                <span>{t("app.sessionPreset")}</span>
                <select
                  aria-label={t("app.sessionPreset")}
                  value={activeSessionPresetId}
                  onChange={(event) => void handleSessionPresetChange(event.currentTarget.value)}
                  disabled={!selectedSession || enabledPresets.length === 0}
                >
                  {enabledPresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>{preset.name}</option>
                  ))}
                </select>
              </label>
              <p className="field-hint">{t("app.sessionPresetHint")}</p>
            </div>

            <div className="panel-section">
              <div className="eyebrow">{t("app.sessions")}</div>
              <label className="field">
                <span>{t("app.newSessionPreset")}</span>
                <select
                  aria-label={t("app.newSessionPreset")}
                  value={newSessionPresetId}
                  onChange={(event) => setNewSessionPresetId(event.currentTarget.value)}
                  disabled={enabledPresets.length === 0}
                >
                  {enabledPresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>{preset.name}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleCreateSession()}
                disabled={!selectedWorld || enabledPresets.length === 0}
              >
                {t("app.createSession")}
              </button>
              <ul className="stack-list">
                {sessions.length > 0 ? sessions.map((session) => (
                  <li key={session.id}>
                    <button
                      type="button"
                      className={selectedSession?.id === session.id ? "list-button active" : "list-button"}
                      onClick={() => setSelectedSession(session)}
                    >
                      <span>{session.id}</span>
                      <span className="workspace-meta">{formatPresetName(resolveSessionPresetId(session, defaultPresetId))}</span>
                    </button>
                  </li>
                )) : (
                  <li className="empty-copy">{selectedWorld ? t("app.emptySessionBody") : t("app.emptyWorldBody")}</li>
                )}
              </ul>
            </div>

            <div className="panel-section">
              <div className="eyebrow">{t("app.archives")}</div>
              <button className="primary-button" onClick={() => void handleCreateArchive()} disabled={!selectedSession}>
                {t("app.createSnapshot")}
              </button>
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
