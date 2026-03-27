import { Fragment, useMemo, useState } from "react";

import { listHostPanels } from "../panel-registry.js";
import { useI18n } from "../i18n.js";
import type {
  ArchiveRecord,
  PackageStateRecord,
  PackageSummary,
  PresetSummary,
  SessionRecord,
  TraceRecord,
  WorkflowSnapshotRecord,
  WorkspaceState,
  WorldRecord
} from "../types.js";

type SidePanelTab = "session" | "quests" | "world" | "debug";

interface WorkbenchSidePanelProps {
  activeSessionPresetId: string;
  archives: ArchiveRecord[];
  guideStateRecords: PackageStateRecord[];
  packages: PackageSummary[];
  presets: PresetSummary[];
  selectedSession: SessionRecord | null;
  selectedWorld: WorldRecord | null;
  sessions: SessionRecord[];
  status: "idle" | "streaming";
  traceEntries: TraceRecord[];
  traceId: string | null;
  workflowSnapshots: WorkflowSnapshotRecord[];
  workspace: WorkspaceState;
  onRestoreArchive(archiveVersionId: string): void;
  onSessionSelect(session: SessionRecord): void;
}

export function WorkbenchSidePanel(props: WorkbenchSidePanelProps) {
  const { locale, t } = useI18n();
  const [activeTab, setActiveTab] = useState<SidePanelTab>("session");
  const hostPanels = useMemo(() => listHostPanels(), []);
  const currentPreset = props.presets.find((preset) => preset.id === props.activeSessionPresetId) ?? null;
  const latestGuideState = [...props.guideStateRecords].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  );
  const packageActivity = props.packages.map((pkg) => ({
    ...pkg,
    guideStateCount: props.guideStateRecords.filter((record) => record.packageName === pkg.name).length,
    patchCount: props.workspace.recentStatePatches.filter((patch) => patch.packageName === pkg.name).length,
    ownsPendingBlock: props.workspace.pendingBlock?.meta.package === pkg.name
  }));
  const groupedWorkflowSnapshots = groupWorkflowSnapshotsByRun(props.workflowSnapshots);
  const runtimeMetrics = [
    {
      label: t("app.trace"),
      value: String(props.traceEntries.length)
    },
    {
      label: t("sidePanel.workflowSnapshots"),
      value: String(props.workflowSnapshots.length)
    },
    {
      label: t("runtime.artifacts"),
      value: String(props.workspace.recentArtifacts.length)
    },
    {
      label: t("runtime.statePatch"),
      value: String(props.workspace.recentStatePatches.length)
    }
  ];
  const contextSummary = [
    {
      label: t("sidePanel.world"),
      value: props.selectedWorld?.name ?? t("app.emptyWorldTitle")
    },
    {
      label: t("sidePanel.session"),
      value: props.selectedSession?.id ?? t("app.noSessionSelected")
    },
    {
      label: t("app.sessionPreset"),
      value: currentPreset?.name ?? t("app.sessionPresetUnbound")
    },
    {
      label: t("app.statusLabel"),
      value: props.status === "idle" ? t("app.status.idle") : t("app.status.streaming")
    }
  ];
  const tabs: Array<{ id: SidePanelTab; label: string; marker: string }> = [
    { id: "session", label: t("sidePanel.session"), marker: locale === "en" ? "SE" : "会" },
    { id: "quests", label: t("sidePanel.quests"), marker: locale === "en" ? "ST" : "引" },
    { id: "world", label: t("sidePanel.world"), marker: locale === "en" ? "WO" : "界" },
    { id: "debug", label: t("sidePanel.debug"), marker: locale === "en" ? "RT" : "运" }
  ];

  return (
    <div className="workbench-side-panel">
      <section className="panel-section side-panel-summary">
        <div className="eyebrow">{t("app.contextPanel")}</div>
        <p className="field-hint">{t("app.contextPanelSummary")}</p>
        <dl className="context-summary-grid">
          {contextSummary.map((item) => (
            <div key={item.label} className="context-summary-item">
              <dt className="workspace-meta">{item.label}</dt>
              <dd className="summary-value">{item.value}</dd>
            </div>
          ))}
        </dl>
        {props.workspace.pendingBlock ? (
          <div className="runtime-row compact-runtime-row">
            <span>{t("app.pendingBlock")}</span>
            <span className="workspace-meta">{props.workspace.pendingBlock.type}</span>
          </div>
        ) : null}
      </section>

      <nav className="side-tab-rail" aria-label="Side panel">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={activeTab === tab.id ? "side-tab active" : "side-tab"}
            aria-pressed={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="side-tab-marker" aria-hidden="true">{tab.marker}</span>
            <span className="side-tab-label">{tab.label}</span>
          </button>
        ))}
      </nav>

      <div className="side-panel-content">
        {activeTab === "session" ? (
          <>
            <section className="panel-section">
              <div className="runtime-row">
                <span>{t("app.sessionPreset")}</span>
                <span className="workspace-meta">
                  {currentPreset ? `${currentPreset.name} · ${currentPreset.model}` : t("app.sessionPresetUnbound")}
                </span>
              </div>
            </section>

            <section className="panel-section">
              <div className="section-heading">
                <span className="section-title">{t("app.sessions")}</span>
                <span className="workspace-meta section-count">{props.sessions.length}</span>
              </div>
              <ul className="stack-list">
                {props.sessions.length > 0 ? props.sessions.map((session) => (
                  <li key={session.id}>
                    <button
                      type="button"
                      className={props.selectedSession?.id === session.id ? "list-button active" : "list-button"}
                      onClick={() => props.onSessionSelect(session)}
                    >
                      <span>{session.id}</span>
                      <span className="workspace-meta">{formatSessionStatus(session.status, t)}</span>
                    </button>
                  </li>
                )) : (
                  <li className="empty-copy">{t("app.emptySessionBody")}</li>
                )}
              </ul>
            </section>

            <section className="panel-section">
              <div className="section-heading">
                <span className="section-title">{t("app.archives")}</span>
                <span className="workspace-meta section-count">{props.archives.length}</span>
              </div>
              <ul className="stack-list">
                {props.archives.length > 0 ? props.archives.map((archive) => (
                  <li key={archive.id} className="archive-row">
                    <span>{archive.id}</span>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => props.onRestoreArchive(archive.id)}
                    >
                      {t("app.restoreAsFork")}
                    </button>
                  </li>
                )) : (
                  <li className="empty-copy">{t("app.notAvailable")}</li>
                )}
              </ul>
            </section>
          </>
        ) : null}

        {activeTab === "quests" ? (
          <section className="panel-section">
            <div className="eyebrow">{t("sidePanel.quests")}</div>
            {props.workspace.pendingBlock?.meta.package === "core-guide" ? (
              <div className="inspector-card">
                <div className="runtime-row">
                  <span>{t("app.pendingBlock")}</span>
                  <span className="workspace-meta">
                    {String((props.workspace.pendingBlock.data as { title?: string }).title ?? props.workspace.pendingBlock.type)}
                  </span>
                </div>
              </div>
            ) : null}
            {latestGuideState.length > 0 ? (
              <ul className="stack-list">
                {latestGuideState.map((record) => (
                  <li key={`${record.collection}:${record.key}`} className="runtime-row">
                    <span>{String(record.value.label ?? record.key)}</span>
                    <span className="workspace-meta">
                      {t("sidePanel.guideTopic")}: {String(record.value.topic ?? t("app.notAvailable"))}
                    </span>
                    <span className="workspace-meta">
                      {t("sidePanel.guideUpdatedAt")}: {formatTimestamp(record.updatedAt, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-copy">{t("sidePanel.guideStateEmpty")}</p>
            )}
          </section>
        ) : null}

        {activeTab === "world" ? (
          <>
            <section className="panel-section">
              <div className="section-heading">
                <span className="section-title">{t("sidePanel.world")}</span>
              </div>
              <div className="inspector-card">
                <strong>{props.selectedWorld?.name ?? t("app.emptyWorldTitle")}</strong>
                {"\n\n"}
                {props.selectedWorld?.description ?? t("app.emptyWorldBody")}
              </div>
            </section>

            <section className="panel-section">
              <div className="eyebrow">{t("sidePanel.pendingInteraction")}</div>
              {props.workspace.pendingBlock ? (
                <div className="runtime-row">
                  <span>{props.workspace.pendingBlock.type}</span>
                  <span className="workspace-meta">{props.workspace.pendingBlock.meta.package}</span>
                </div>
              ) : (
                <p className="empty-copy">{t("app.notAvailable")}</p>
              )}
            </section>
          </>
        ) : null}

        {activeTab === "debug" ? (
          <>
            <section className="panel-section">
              <div className="eyebrow">{t("sidePanel.debug")}</div>
              <p className="field-hint">{t("sidePanel.debugSummary")}</p>
              <div className="runtime-row">
                <span>{t("app.trace")}</span>
                <span className="workspace-meta">{props.traceId ?? t("trace.none")}</span>
              </div>
              <div className="runtime-row">
                <span>{t("sidePanel.traceCount")}</span>
                <span className="workspace-meta">{props.traceEntries.length}</span>
              </div>
              <div className="runtime-row">
                <span>{t("app.localeLabel")}</span>
                <span className="workspace-meta">{locale}</span>
              </div>
              <div className="runtime-metric-grid">
                {runtimeMetrics.map((metric) => (
                  <div key={metric.label} className="metric-card">
                    <span className="metric-value">{metric.value}</span>
                    <span className="workspace-meta">{metric.label}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel-section">
              <div className="eyebrow">{t("sidePanel.workflowSnapshots")}</div>
              {groupedWorkflowSnapshots.length > 0 ? (
                <ul className="stack-list">
                  {groupedWorkflowSnapshots.map((group, index) => (
                    <li key={`${group.runId}:debug`}>
                      <details className="detail-disclosure" open={index === 0}>
                        <summary className="detail-summary">
                          <span>{group.runId}</span>
                          <span className="workspace-meta">{group.latestStatus} · {group.latestStepId}</span>
                        </summary>
                        <ul className="detail-body">
                          {group.snapshots.map((snapshot) => (
                            <li key={`${snapshot.runId}:${snapshot.stepId}`} className="runtime-row">
                              <strong>{snapshot.stepId}</strong>
                              <span className="workspace-meta">{snapshot.status}</span>
                              <pre className="payload-preview">
                                {JSON.stringify(snapshot.suspendPayload ?? snapshot.resumeData ?? {}, null, 2)}
                              </pre>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty-copy">{t("sidePanel.workflowSnapshotsEmpty")}</p>
              )}
            </section>

            <section className="panel-section">
              <div className="eyebrow">{t("sidePanel.packages")}</div>
              {packageActivity.length > 0 ? (
                <ul className="stack-list">
                  {packageActivity.map((pkg) => (
                    <li key={`${pkg.name}:runtime`} className="runtime-row">
                      <span>{pkg.name}</span>
                      <span className="workspace-meta">patches {pkg.patchCount} · state {pkg.guideStateCount}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty-copy">{t("sidePanel.packagesEmpty")}</p>
              )}
            </section>

            {hostPanels.map((panel) => (
              <Fragment key={panel.id}>
                {panel.render({
                  artifacts: props.workspace.recentArtifacts,
                  statePatches: props.workspace.recentStatePatches,
                  traceEntries: props.traceEntries,
                  traceId: props.traceId,
                  workflowRuns: props.workspace.workflowRuns
                })}
              </Fragment>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}

function formatSessionStatus(
  value: string | null | undefined,
  t: (key: "app.sessionStatus.active" | "app.sessionStatus.waiting_for_input" | "app.sessionStatus.unknown" | "app.notAvailable") => string
): string {
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

function formatTimestamp(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function groupWorkflowSnapshotsByRun(snapshots: WorkflowSnapshotRecord[]) {
  const groups = new Map<string, WorkflowSnapshotRecord[]>();

  for (const snapshot of snapshots) {
    const group = groups.get(snapshot.runId) ?? [];
    group.push(snapshot);
    groups.set(snapshot.runId, group);
  }

  return Array.from(groups.entries())
    .map(([runId, groupedSnapshots]) => {
      const sortedSnapshots = [...groupedSnapshots].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt)
      );

      return {
        runId,
        snapshots: sortedSnapshots,
        latestStatus: sortedSnapshots[0]?.status ?? "running",
        latestStepId: sortedSnapshots[0]?.stepId ?? "step"
      };
    })
    .sort((left, right) =>
      String(right.snapshots[0]?.updatedAt ?? "").localeCompare(String(left.snapshots[0]?.updatedAt ?? ""))
    );
}
