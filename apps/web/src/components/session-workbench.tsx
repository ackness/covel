import React from "react";

import { BlockRenderer } from "../block-renderer-registry.js";
import { useI18n } from "../i18n.js";
import { MessageContent } from "./message-content.js";
import { SlashCommandMenu } from "./slash-command-menu.js";
import type {
  CommandSummary,
  PresetSummary,
  SessionRecord,
  TimelineItem,
  WorldRecord,
  WorkspaceState
} from "../types.js";

interface SessionWorkbenchProps {
  activeSessionPresetId: string;
  activeSessionPresetName: string;
  canSend: boolean;
  composer: string;
  composerFormRef: React.RefObject<HTMLFormElement | null>;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  emptyTimelinePrompt: string;
  newSessionPresetId: string;
  normalizedSlashSelectedIndex: number;
  pendingBlockRef: React.RefObject<HTMLElement | null>;
  newSessionPresetOptions: PresetSummary[];
  selectedSession: SessionRecord | null;
  sessionPresetOptions: PresetSummary[];
  selectedWorld: WorldRecord | null;
  sessions: SessionRecord[];
  showSlashMenu: boolean;
  slashSuggestions: CommandSummary[];
  status: "idle" | "streaming";
  workbenchDescription: string;
  workbenchTitle: string;
  workspace: WorkspaceState;
  onBlockSelection(optionId: string): void;
  onComposerChange(nextValue: string): void;
  onComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void;
  onCreateArchive(): void;
  onCreateSession(): void;
  onNewSessionPresetChange(nextPresetId: string): void;
  onSendMessage(event: React.FormEvent<HTMLFormElement>): void;
  onSessionPresetChange(nextPresetId: string): void;
  onSessionSelect(sessionId: string): void;
  onSlashSelect(command: CommandSummary): void;
}

export function SessionWorkbench(props: SessionWorkbenchProps) {
  const { t } = useI18n();
  const displayTitle = props.selectedWorld ? props.workbenchTitle : t("app.emptyWorldTitle");
  const displayDescription = props.selectedWorld ? props.workbenchDescription : t("app.emptyWorldBody");
  const summaryItems = [
    {
      label: t("app.session"),
      value: props.selectedSession?.id ?? t("app.noSessionSelected")
    },
    {
      label: t("app.statusLabel"),
      value: formatStatusLabel(props.status, t)
    },
    {
      label: t("app.sessionPreset"),
      value: props.activeSessionPresetName
    },
    {
      label: t("app.pendingBlock"),
      value: props.workspace.pendingBlock ? t("app.pendingBlock") : t("app.notAvailable")
    }
  ];

  return (
    <main className="workspace-main" aria-label={t("app.activeWorkspace")}>
      <section className="workspace-hero">
        <div className="workbench-section-header">
          <div className="eyebrow">{t("app.activeWorkspace")}</div>
        </div>

        <div className="stage-shell">
          <div className="stage-copy">
            <div className="eyebrow">{t("app.worldPrimer")}</div>
            <h1 className="hero-title">{displayTitle}</h1>
            <p className="hero-copy">{displayDescription}</p>
            <dl className="hero-summary-grid">
              {summaryItems.map((item) => (
                <div key={item.label} className="summary-card">
                  <dt className="workspace-meta">{item.label}</dt>
                  <dd className="summary-value">{item.value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="session-toolbar">
            <section className="panel-section toolbar-card">
              <div className="eyebrow">{t("app.sessionControls")}</div>
              <div className="toolbar-fields">
                <label className="field compact-field">
                  <span>{t("app.session")}</span>
                  <select
                    aria-label={t("app.session")}
                    value={props.selectedSession?.id ?? ""}
                    onChange={(event) => props.onSessionSelect(event.currentTarget.value)}
                    disabled={props.sessions.length === 0}
                  >
                    {props.sessions.length === 0 ? (
                      <option value="">{t("app.noSessionSelected")}</option>
                    ) : null}
                    {props.sessions.map((session) => (
                      <option key={session.id} value={session.id}>
                        {session.id}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="field compact-field">
                  <span>{t("app.sessionPreset")}</span>
                  <select
                    aria-label={t("app.sessionPreset")}
                    value={props.activeSessionPresetId}
                    onChange={(event) => props.onSessionPresetChange(event.currentTarget.value)}
                    disabled={!props.selectedSession || props.sessionPresetOptions.length === 0}
                  >
                    {props.sessionPresetOptions.map((preset) => (
                      <option key={preset.id} value={preset.id}>{preset.name}</option>
                    ))}
                  </select>
                </label>

                <label className="field compact-field">
                  <span>{t("app.newSessionPreset")}</span>
                  <select
                    aria-label={t("app.newSessionPreset")}
                    value={props.newSessionPresetId}
                    onChange={(event) => props.onNewSessionPresetChange(event.currentTarget.value)}
                    disabled={props.newSessionPresetOptions.length === 0}
                  >
                    {props.newSessionPresetOptions.map((preset) => (
                      <option key={preset.id} value={preset.id}>{preset.name}</option>
                    ))}
                  </select>
                </label>
              </div>
            </section>

            <section className="panel-section toolbar-card">
              <div className="eyebrow">{t("app.createSession")}</div>
              <div className="session-toolbar-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => props.onCreateSession()}
                  disabled={!props.selectedWorld || props.newSessionPresetOptions.length === 0}
                >
                  {t("app.createSession")}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => props.onCreateArchive()}
                  disabled={!props.selectedSession}
                >
                  {t("app.createSnapshot")}
                </button>
              </div>
            </section>
          </div>
        </div>
      </section>

      {props.selectedSession ? (
        <>
          <section className="timeline">
            {props.workspace.timeline.length > 0 ? props.workspace.timeline.map((item) => (
              <TimelineRow
                key={item.id}
                item={item}
                pendingBlockId={props.workspace.pendingBlock?.id ?? null}
                onBlockSelection={props.onBlockSelection}
              />
            )) : (
              <div className="timeline-empty">
                <div className="eyebrow">{t("app.emptyTimelineTitle")}</div>
                <p className="empty-copy">{props.emptyTimelinePrompt}</p>
              </div>
            )}
          </section>

          {props.workspace.pendingBlock ? (
            <section ref={props.pendingBlockRef} className="pending-block" aria-label={t("app.pendingBlock")}>
              <div className="eyebrow">{t("app.pendingBlock")}</div>
              <BlockRenderer
                block={props.workspace.pendingBlock}
                onChoiceSelect={(optionId) => props.onBlockSelection(optionId)}
              />
            </section>
          ) : null}

          <form ref={props.composerFormRef} className="composer" onSubmit={props.onSendMessage}>
            <div className="composer-stack">
              {props.showSlashMenu ? (
                <SlashCommandMenu
                  label={t("app.commandSuggestions")}
                  commands={props.slashSuggestions}
                  selectedIndex={props.normalizedSlashSelectedIndex}
                  onSelect={props.onSlashSelect}
                />
              ) : null}
              <label className="field composer-field">
                <span>{t("app.composer")}</span>
                <textarea
                  ref={props.composerRef}
                  aria-label={t("app.composer")}
                  value={props.composer}
                  onChange={(event) => props.onComposerChange(event.currentTarget.value)}
                  onKeyDown={props.onComposerKeyDown}
                  disabled={props.status === "streaming"}
                />
              </label>
            </div>
            <button type="submit" className="primary-button" disabled={!props.canSend}>{t("app.send")}</button>
          </form>
        </>
      ) : (
        <section className="timeline-empty">
          <div className="eyebrow">{props.selectedWorld ? t("app.emptySessionTitle") : t("app.emptyWorldTitle")}</div>
          <p className="empty-copy">{props.selectedWorld ? t("app.emptySessionBody") : t("app.emptyWorldBody")}</p>
          <div className="hero-actions">
            {props.selectedWorld ? (
              <button type="button" className="primary-button" onClick={() => props.onCreateSession()}>
                {t("app.createSession")}
              </button>
            ) : null}
          </div>
        </section>
      )}
    </main>
  );
}

function TimelineRow(input: {
  item: WorkspaceState["timeline"][number];
  onBlockSelection(optionId: string): void;
  pendingBlockId: string | null;
}) {
  const { t } = useI18n();

  if (input.item.kind === "message") {
    return (
      <article className={`message message-${input.item.role}`}>
        <div className="message-role">{formatTimelineRole(input.item, t)}</div>
        <MessageContent
          content={input.item.content}
          role={input.item.role}
          streaming={input.item.streaming}
        />
      </article>
    );
  }

  if (input.item.pending && input.pendingBlockId === input.item.id) {
    return null;
  }

  return (
    <article className="message message-block">
      <div className="message-role">{input.item.block.type}</div>
      <BlockRenderer
        block={input.item.block}
        onChoiceSelect={input.item.pending ? (optionId) => input.onBlockSelection(optionId) : undefined}
      />
    </article>
  );
}

function formatTimelineRole(
  item: TimelineItem,
  t: (key: "app.role.assistant" | "app.role.user") => string
): string {
  return item.role === "assistant" ? t("app.role.assistant") : t("app.role.user");
}

function formatStatusLabel(
  value: "idle" | "streaming",
  t: (key: "app.status.idle" | "app.status.streaming") => string
): string {
  return value === "idle" ? t("app.status.idle") : t("app.status.streaming");
}
