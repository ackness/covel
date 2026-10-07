import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchServerHealth, fetchUiSpecs } from "@/services/api.js";
import type { ServerStoreBackend } from "@/services/data-service.js";
import {
  aggregateSpecsIntoGroups,
  pluginPanelKey,
  resolvePluginPanelTarget,
  type PluginPanelTabGroup,
} from "@/lib/plugin-panel-tabs.js";
import { useSession } from "@/stores/session-store.js";
import { type RightPanelRequest } from "@/lib/nav-events.js";
import { ignoreError } from "@/lib/ignore-error.js";
import type { PluginPanelStateCache } from "./plugin-panel.js";

export interface StorageStatusData {
  readonly backend?: ServerStoreBackend;
  readonly frontendMode?: "local" | "remote";
}

/** Where the request for the plugin panel definitions stands. */
export type PanelSpecsStatus = "loading" | "ready" | "error";

/**
 * What the right panel has to remember between two renders of itself: the
 * open tab, the plugin panels the server described and the selection inside
 * each of them.
 */
export interface RightPanelState {
  readonly activeTab: string;
  readonly setActiveTab: (tab: string) => void;
  /** Group id → key of the sub-panel shown in that group. */
  readonly activePluginSubTab: Readonly<Record<string, string>>;
  readonly selectPluginSubTab: (groupId: string, panelKey: string) => void;
  readonly pluginTabGroups: PluginPanelTabGroup[];
  readonly specsStatus: PanelSpecsStatus;
  readonly specsError: string | null;
  readonly retrySpecs: () => void;
  readonly storageData: StorageStatusData | null;
  readonly panelStateCache: PluginPanelStateCache;
}

/**
 * Own the right panel's state outside the panel.
 *
 * At phone width the panel sits in a drawer that unmounts it on close. State
 * kept inside the panel would be lost each time: the player would land on the
 * first tab again, the panel definitions would be requested again, and a
 * navigation request that was already followed would be followed once more.
 * The session view calls this hook and hands the result to the panel, so the
 * state lasts as long as the session view does.
 */
export function useRightPanelState(
  sessionId: string,
  panelRequest?: RightPanelRequest | null,
): RightPanelState {
  const { i18n } = useTranslation();
  const { state: sessionState } = useSession();
  const panelStateCacheRef = useRef<PluginPanelStateCache>(new Map());
  const [storageData, setStorageData] = useState<StorageStatusData | null>(
    null,
  );
  const [pluginTabGroups, setPluginTabGroups] = useState<PluginPanelTabGroup[]>(
    [],
  );
  const [specsStatus, setSpecsStatus] = useState<PanelSpecsStatus>("loading");
  const [specsError, setSpecsError] = useState<string | null>(null);
  const [specsAttempt, setSpecsAttempt] = useState(0);
  const [activePluginSubTab, setActivePluginSubTab] = useState<
    Record<string, string>
  >({});
  const [activeTab, setActiveTab] = useState("world");
  const [pendingPanelRequest, setPendingPanelRequest] =
    useState<RightPanelRequest | null>(null);
  const activePluginKey = useMemo(
    () =>
      sessionState.sessionPlugins
        .filter((plugin) => plugin.active)
        .map((plugin) => plugin.id)
        .sort()
        .join("\u001f"),
    [sessionState.sessionPlugins],
  );

  useEffect(() => {
    fetchServerHealth()
      .then((h) => setStorageData(h.storage?.data ?? null))
      .catch(ignoreError("fetch server health"));
  }, []);

  // A request is taken once, when it arrives. Repeated requests use a new
  // object even when the target is the same.
  useEffect(() => {
    if (panelRequest) setPendingPanelRequest(panelRequest);
  }, [panelRequest]);

  // Preserve the intent until the asynchronous plugin specs exist.
  useEffect(() => {
    if (!pendingPanelRequest) return;
    const { event } = pendingPanelRequest;
    if (event === "open-database") {
      setActiveTab("database");
      setPendingPanelRequest(null);
      return;
    }
    const imageGroup =
      event === "open-images"
        ? pluginTabGroups.find((group) =>
            group.subPanels.some((sub) => sub.icon === "image"),
          )
        : undefined;
    const imagePanel = imageGroup?.subPanels.find(
      (sub) => sub.icon === "image",
    );
    const target =
      typeof event === "object"
        ? resolvePluginPanelTarget(
            pluginTabGroups,
            event.pluginId,
            event.panelId,
          )
        : imageGroup && imagePanel
          ? {
              groupId: imageGroup.id,
              subPanelIndex: imageGroup.subPanels.indexOf(imagePanel),
            }
          : null;
    if (!target) return;
    const group = pluginTabGroups.find((item) => item.id === target.groupId)!;
    setActivePluginSubTab((previous) => ({
      ...previous,
      [target.groupId]: pluginPanelKey(group.subPanels[target.subPanelIndex]!),
    }));
    setActiveTab(`plugin-${target.groupId}`);
    setPendingPanelRequest(null);
  }, [pendingPanelRequest, pluginTabGroups]);

  // Load localized panel definitions; the session provider owns data hydration.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setSpecsStatus("loading");
    setSpecsError(null);
    fetchUiSpecs(sessionId)
      .then((specs) => {
        if (cancelled) return;

        // Surface server-side validation diagnostics for rejected specs so a
        // plugin author sees the exact plugin/field/problem in dev instead of
        // a panel silently missing its tab.
        if (import.meta.env.DEV && specs.diagnostics?.length) {
          for (const diag of specs.diagnostics) {
            const where = `${diag.pluginId} (${diag.runtimeId}) ${diag.slot}[${diag.specIndex}]${
              diag.specId ? ` "${diag.specId}"` : ""
            }`;
            const why = diag.issues
              .map((issue) => `${issue.path}: ${issue.message}`)
              .join("; ");
            // eslint-disable-next-line no-console
            console.warn(`[ui-specs] dropped invalid spec — ${where}: ${why}`);
          }
        }

        setPluginTabGroups(
          aggregateSpecsIntoGroups(specs.right, i18n.language, {
            warn: (message) => {
              if (import.meta.env.DEV) {
                // eslint-disable-next-line no-console
                console.warn(message);
              }
            },
          }),
        );
        setSpecsStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        ignoreError("fetch ui specs for right panel")(error);
        // The panels of an earlier load stay; only the status changes, so the
        // panel can say that the plugin tabs are missing or out of date.
        setSpecsError(error instanceof Error ? error.message : String(error));
        setSpecsStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, activePluginKey, i18n.language, specsAttempt]);

  const selectPluginSubTab = useCallback(
    (groupId: string, panelKey: string) =>
      setActivePluginSubTab((previous) => ({
        ...previous,
        [groupId]: panelKey,
      })),
    [],
  );
  const retrySpecs = useCallback(
    () => setSpecsAttempt((attempt) => attempt + 1),
    [],
  );

  // One object per state: the panel is memoised on it, so a re-render of the
  // session view alone must not hand it a new one.
  return useMemo(
    () => ({
      activeTab,
      setActiveTab,
      activePluginSubTab,
      selectPluginSubTab,
      pluginTabGroups,
      specsStatus,
      specsError,
      retrySpecs,
      storageData,
      panelStateCache: panelStateCacheRef.current,
    }),
    [
      activeTab,
      activePluginSubTab,
      selectPluginSubTab,
      pluginTabGroups,
      specsStatus,
      specsError,
      retrySpecs,
      storageData,
    ],
  );
}
