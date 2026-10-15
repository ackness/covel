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
  /** A bar across the game view, or a card on the session prep screen. */
  readonly variant: "bar" | "card";
}

const boxClass = {
  bar: "relative z-10 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs",
  card: "mb-5 rounded-(--radius-card) border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm",
} as const;

/**
 * Tells the player which plugins of the session are off and why, with a
 * button for each installed plugin that would bring one back, and explains
 * what to do when no plugin tells the story.
 */
export function SessionPluginNotices({
  plugins,
  unavailable,
  pendingApproval = [],
  offTitle,
  busy,
  onTurnOn,
  variant,
}: SessionPluginNoticesProps) {
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
  return (
    <>
      {pendingApproval.length > 0 && (
        <div
          role="status"
          data-testid="pending-approval-plugins"
          className={boxClass[variant]}
        >
          <p className="font-medium">{t("session.pendingApproval.title")}</p>
          <ul className="mt-1 list-disc pl-4">
            {pendingApproval.map((item) => (
              <li key={item.pluginId}>{pluginOffReason(t, item, plugins)}</li>
            ))}
          </ul>
          <p className="mt-1">{t("session.pendingApproval.detail")}</p>
        </div>
      )}
      {unavailable.length > 0 && (
        <div
          role="status"
          data-testid="unavailable-session-plugins"
          className={boxClass[variant]}
        >
          <p>{offTitle}</p>
          <ul className="mt-1 list-disc pl-4">
            {unavailable.map((item) => (
              <li key={item.pluginId}>{pluginOffReason(t, item, plugins)}</li>
            ))}
          </ul>
          {fixes.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-2">{turnOn(fixes)}</div>
          )}
        </div>
      )}
      {noStory && (
        <div
          role="status"
          data-testid="no-story-plugin"
          className={boxClass[variant]}
        >
          <p className="font-medium">{t("plugin.noStory.title")}</p>
          <p>{t("plugin.noStory.detail")}</p>
          {storyCandidates.length > 0 ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span>
                {t("plugin.noStory.enable", {
                  plugins: formatList(
                    storyCandidates.map((id) => pluginName(plugins, id)),
                    "or",
                  ),
                })}
              </span>
              {turnOn(storyCandidates)}
            </div>
          ) : storyPending ? (
            <p>{t("plugin.noStory.approvalRequired")}</p>
          ) : (
            <p>{t("plugin.noStory.install")}</p>
          )}
        </div>
      )}
    </>
  );
}
