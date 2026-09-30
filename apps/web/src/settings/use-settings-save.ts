import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { SettingsRevisionConflictError } from "@covel/settings";
import { useTranslation } from "react-i18next";
import { emitToast } from "@/lib/toast-channel.js";
import { useSettingsStore } from "./use-settings.js";

export function useSettingsWritable(): boolean {
  const store = useSettingsStore();
  const subscribe = useCallback(
    (notify: () => void) => store.subscribePersistenceErrors(() => notify()),
    [store],
  );
  return useSyncExternalStore(
    subscribe,
    () => store.isHydrated(),
    () => false,
  );
}

/** Await persistence once and restore the panel from the confirmed store. */
export function useSettingsSave(restore: () => void) {
  const { t } = useTranslation();
  const writable = useSettingsWritable();
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [saving, setSaving] = useState(false);
  const save = async (operation: () => Promise<void>): Promise<boolean> => {
    if (!writable || pending.current || !mounted.current) return false;
    pending.current = true;
    setSaving(true);
    try {
      await operation();
      return true;
    } catch (error) {
      if (!(error instanceof SettingsRevisionConflictError))
        emitToast(
          "error",
          t("settings.saveFailed"),
          error instanceof Error ? error.message : String(error),
        );
      return false;
    } finally {
      if (mounted.current) restore();
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  return { save, saving, writable };
}
