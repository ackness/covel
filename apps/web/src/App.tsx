import { startTransition, useEffect, useState } from "react";

import {
  createArchive,
  createWorld,
  listArchives,
  listMessages,
  listPackages,
  listSessions,
  listWorlds,
  restoreArchive,
  sendMessage,
  submitBlockResponse
} from "./api.js";
import { applySseEvent, createInitialWorkspaceState, timelineFromMessages } from "./state.js";
import type { ArchiveRecord, SessionRecord, WorldRecord, WorkspaceState } from "./types.js";

export function App() {
  const [worlds, setWorlds] = useState<WorldRecord[]>([]);
  const [packages, setPackages] = useState<Array<{ name: string; enabled: boolean }>>([]);
  const [selectedWorldId, setSelectedWorldId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [selectedSession, setSelectedSession] = useState<SessionRecord | null>(null);
  const [archives, setArchives] = useState<ArchiveRecord[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceState>(createInitialWorkspaceState());
  const [composer, setComposer] = useState("");
  const [worldName, setWorldName] = useState("");
  const [worldDescription, setWorldDescription] = useState("");
  const [status, setStatus] = useState("Idle");

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

    setStatus("Streaming");
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
      setStatus("Idle");
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
      workingSummary: "Working summary",
      archiveSummary: "Archive summary"
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

  return (
    <div className="workspace-shell">
      <aside className="workspace-panel panel-left">
        <div className="panel-section">
          <div className="eyebrow">Worlds</div>
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
          <div className="eyebrow">Create World</div>
          <label className="field">
            <span>World Name</span>
            <input value={worldName} onChange={(event) => setWorldName(event.currentTarget.value)} />
          </label>
          <label className="field">
            <span>World Description</span>
            <textarea value={worldDescription} onChange={(event) => setWorldDescription(event.currentTarget.value)} />
          </label>
          <button type="submit" className="primary-button">Create World</button>
        </form>

        <div className="panel-section">
          <div className="eyebrow">Packages</div>
          <ul className="stack-list">
            {packages.map((pkg) => (
              <li key={pkg.name} className="package-row">
                <span>{pkg.name}</span>
                <span>{pkg.enabled ? "Enabled" : "Disabled"}</span>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <main className="workspace-main">
        <header className="workspace-header">
          <div>
            <div className="brand">covel</div>
            <div className="workspace-meta">{selectedSession?.id ?? "No session"}</div>
          </div>
          <div className="workspace-meta">{status}</div>
        </header>

        <section className="timeline">
          {workspace.timeline.map((item) => (
            <article key={item.id} className={`message message-${item.role}`}>
              <div className="message-role">{item.role}</div>
              <div>{item.content}</div>
            </article>
          ))}
        </section>

        {workspace.pendingBlock ? (
          <section className="pending-block">
            <div className="eyebrow">{workspace.pendingBlock.type}</div>
            <h3>{String((workspace.pendingBlock.data as { title?: string }).title ?? "Pending block")}</h3>
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
            <span>Composer</span>
            <textarea value={composer} onChange={(event) => setComposer(event.currentTarget.value)} />
          </label>
          <button type="submit" className="primary-button">Send</button>
        </form>
      </main>

      <aside className="workspace-panel panel-right">
        <div className="panel-section">
          <div className="eyebrow">Session</div>
          <div className="session-card">
            <div>{selectedSession?.id ?? "No session selected"}</div>
            <div>{selectedSession?.status ?? "n/a"}</div>
          </div>
        </div>

        <div className="panel-section">
          <div className="eyebrow">Archives</div>
          <button className="primary-button" onClick={handleCreateArchive}>Create Snapshot</button>
          <ul className="stack-list">
            {archives.map((archive) => (
              <li key={archive.id} className="archive-row">
                <span>{archive.id}</span>
                <button className="secondary-button" onClick={() => handleRestoreArchive(archive.id)}>
                  Restore As Fork
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="panel-section">
          <div className="eyebrow">Trace</div>
          <div className="session-card">{workspace.lastTraceId ?? "No trace yet"}</div>
        </div>
      </aside>
    </div>
  );
}
