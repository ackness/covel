import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePlatformUiState } from "@/lib/platform-ui-events.js";
import * as apiModule from "@/services/api.js";
import type {
  AppCommandEntry,
  SessionPlugin,
  UISlotEntry,
  UISpecsResponse,
} from "@/services/api.js";

const EMPTY_PLATFORM_SPECS = {
  settingsSection: [] as readonly UISlotEntry[],
  appPage: [] as readonly UISlotEntry[],
  topbarStatus: [] as readonly UISlotEntry[],
  window: [] as readonly UISlotEntry[],
  appCommands: [] as readonly AppCommandEntry[],
};

const EMPTY_SESSION_MICRO_SPECS = {
  composerAction: [] as readonly UISlotEntry[],
  messageAction: [] as readonly UISlotEntry[],
  messageBelow: [] as readonly UISlotEntry[],
  window: [] as readonly UISlotEntry[],
};

function readFetchUiSpecs():
  | ((
      sessionId?: string,
      activePluginKey?: string,
      options?: { readonly silentErrors?: boolean },
    ) => Promise<UISpecsResponse>)
  | undefined {
  const candidate = (apiModule as { fetchUiSpecs?: unknown }).fetchUiSpecs;
  return typeof candidate === "function"
    ? (candidate as (
        sessionId?: string,
        activePluginKey?: string,
        options?: { readonly silentErrors?: boolean },
      ) => Promise<UISpecsResponse>)
    : undefined;
}

export function usePlatformUiSpecs(enabled = true) {
  const { i18n } = useTranslation();
  const { instanceDataVersion } = usePlatformUiState();
  const [specs, setSpecs] = useState(EMPTY_PLATFORM_SPECS);

  useEffect(() => {
    if (!enabled) return;
    const fetchSpecs = readFetchUiSpecs();
    if (!fetchSpecs) return;
    let cancelled = false;
    void Promise.resolve(fetchSpecs(undefined, "", { silentErrors: true }))
      .then((res) => {
        if (cancelled || !res) return;
        setSpecs({
          settingsSection: res.settingsSection ?? [],
          appPage: res.appPage ?? [],
          topbarStatus: res.topbarStatus ?? [],
          window: res.window ?? [],
          appCommands: res.appCommands ?? [],
        });
      })
      .catch(() => {
        // Keep previously loaded platform specs when background refresh fails.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, i18n.language, instanceDataVersion]);

  return specs;
}

export function useSessionPlatformSpecs(
  sessionId: string | undefined,
  sessionPlugins: readonly SessionPlugin[],
) {
  const { i18n } = useTranslation();
  const [specs, setSpecs] = useState(EMPTY_SESSION_MICRO_SPECS);
  const activePluginKey = sessionPlugins
    .filter((plugin) => plugin.active)
    .map((plugin) => plugin.id)
    .sort()
    .join("\u001f");

  useEffect(() => {
    if (!sessionId) {
      setSpecs(EMPTY_SESSION_MICRO_SPECS);
      return;
    }
    const fetchSpecs = readFetchUiSpecs();
    if (!fetchSpecs) return;
    let cancelled = false;
    void Promise.resolve(
      fetchSpecs(sessionId, activePluginKey, { silentErrors: true }),
    )
      .then((res) => {
        if (cancelled || !res) return;
        setSpecs({
          composerAction: res.composerAction ?? [],
          messageAction: res.messageAction ?? [],
          messageBelow: res.messageBelow ?? [],
          window: res.window ?? [],
        });
      })
      .catch(() => {
        if (!cancelled) setSpecs(EMPTY_SESSION_MICRO_SPECS);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, activePluginKey, i18n.language]);

  return specs;
}
