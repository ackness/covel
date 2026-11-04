import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  isDependencyRejection,
  type PluginResolutionRejection,
  type PluginSummary,
} from "@covel/shared";
import {
  contractProviders,
  pluginName,
  pluginOffReason,
  storyPlugins,
} from "@/lib/plugin-notices.js";
import { formatList } from "@/lib/i18n-text.js";
import { useNotice } from "@/lib/notice-center.js";

interface SessionPluginNoticesProps {
  /** Every installed plugin, with `active` for the session's running ones. */
  readonly plugins: readonly (PluginSummary & { readonly active: boolean })[];
  /** Plugins that are off, with why: the session's or the selection's. */
  readonly unavailable: readonly PluginResolutionRejection[];
  /** Prep selections kept for consent after creation; they are not active. */
  readonly pendingApproval?: readonly PluginResolutionRejection[];
  /** The heading of the list of plugins that are off. */
  readonly offTitle: string;
  readonly busy: boolean;
  readonly onTurnOn: (pluginId: string) => void;
}

const boxClass =
  "mb-5 rounded-(--radius-card) border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm";

/** What is wrong with the session's plugin set, shared by both presentations. */
function usePluginNoticeModel({
  plugins,
  unavailable,
  pendingApproval = [],
  busy,
  onTurnOn,
}: Omit<SessionPluginNoticesProps, "offTitle">) {
  const { t } = useTranslation();
  const pendingIds = new Set(pendingApproval.map((item) => item.pluginId));
  const inactive = (ids: Iterable<string>) =>
    [...new Set(ids)].filter(
      (id) =>
        !pendingIds.has(id) &&
        plugins.find((plugin) => plugin.id === id)?.active === false,
    );
  const fixes = inactive(
    unavailable
      .filter(isDependencyRejection)
      .flatMap((item) =>
        contractProviders(plugins, item.contract).map((plugin) => plugin.id),
      ),
  );
  // Until the list arrives nothing is known, so nothing is claimed missing.
  const noStory =
    plugins.length > 0 &&
    storyPlugins(plugins.filter((plugin) => plugin.active)).length === 0;
  const storyCandidates = inactive(
    storyPlugins(plugins).map((plugin) => plugin.id),
  );
  const storyPending = storyPlugins(plugins).some((plugin) =>
    pendingIds.has(plugin.id),
  );
  const turnOn = (ids: readonly string[]) =>
    ids.map((id) => (
      <button
        key={id}
        type="button"
        className="underline"
        disabled={busy}
        onClick={() => onTurnOn(id)}
      >
        {t("plugin.off.turnOn", { plugin: pluginName(plugins, id) })}
      </button>
    ));
  const reasons = unavailable.map((item) => pluginOffReason(t, item, plugins));
  const noStoryHint =
    storyCandidates.length > 0
      ? t("plugin.noStory.enable", {
          plugins: formatList(
            storyCandidates.map((id) => pluginName(plugins, id)),
            "or",
          ),
        })
      : storyPending
        ? t("plugin.noStory.approvalRequired")
        : t("plugin.noStory.install");
  return {
    t,
    fixes,
    noStory,
    storyCandidates,
    turnOn,
    reasons,
    noStoryHint,
    pendingReasons: pendingApproval.map((item) =>
      pluginOffReason(t, item, plugins),
    ),
  };
}

/**
 * The session prep screen's card: which plugins of the selection are off and
 * why, with a button for each installed plugin that would bring one back, and
 * what to do when no plugin tells the story.
 */
export function SessionPluginNotices(props: SessionPluginNoticesProps) {
  const { offTitle } = props;
  const model = usePluginNoticeModel(props);
  const { t, fixes, noStory, storyCandidates, turnOn, reasons } = model;
  return (
    <>
      {model.pendingReasons.length > 0 && (
        <div
          role="status"
          data-testid="pending-approval-plugins"
          className={boxClass}
        >
          <p className="font-medium">{t("session.pendingApproval.title")}</p>
          <ul className="mt-1 list-disc pl-4">
            {model.pendingReasons.map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
          <p className="mt-1">{t("session.pendingApproval.detail")}</p>
        </div>
      )}
      {reasons.length > 0 && (
        <div
          role="status"
          data-testid="unavailable-session-plugins"
          className={boxClass}
        >
          <p>{offTitle}</p>
          <ul className="mt-1 list-disc pl-4">
            {reasons.map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
          {fixes.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-2">{turnOn(fixes)}</div>
          )}
        </div>
      )}
      {noStory && (
        <div role="status" data-testid="no-story-plugin" className={boxClass}>
          <p className="font-medium">{t("plugin.noStory.title")}</p>
          <p>{t("plugin.noStory.detail")}</p>
          {storyCandidates.length > 0 ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span>{model.noStoryHint}</span>
              {turnOn(storyCandidates)}
            </div>
          ) : (
            <p>{model.noStoryHint}</p>
          )}
        </div>
      )}
    </>
  );
}

/**
 * The same facts inside a running game, as cards: plugins that are off, and
 * the missing story plugin (an error, since turns then tell no story).
 */
export function SessionPluginNoticeCards({
  sessionId,
  ...props
}: Omit<SessionPluginNoticesProps, "pendingApproval"> & {
  readonly sessionId: string;
}): null {
  const { offTitle } = props;
  const model = usePluginNoticeModel(props);
  const { t, fixes, noStory, storyCandidates, turnOn, reasons } = model;
  const buttons = (ids: readonly string[]): (() => ReactNode) | undefined =>
    ids.length > 0
      ? () => <div className="flex flex-wrap gap-2">{turnOn(ids)}</div>
      : undefined;
  const offRender = buttons(fixes);
  useNotice(
    reasons.length > 0
      ? {
          key: "plugins-unavailable",
          kind: "card",
          tone: "warning",
          scope: sessionId,
          title: offTitle,
          body: reasons.join("\n"),
          ...(offRender ? { render: offRender } : {}),
        }
      : null,
  );
  const storyRender = buttons(storyCandidates);
  useNotice(
    noStory
      ? {
          key: "no-story-plugin",
          kind: "card",
          tone: "error",
          scope: sessionId,
          title: t("plugin.noStory.title"),
          body: [t("plugin.noStory.detail"), model.noStoryHint].join("\n"),
          ...(storyRender ? { render: storyRender } : {}),
        }
      : null,
  );
  return null;
}
