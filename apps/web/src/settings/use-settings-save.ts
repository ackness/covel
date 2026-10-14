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

/** Serialize edits; each operation reads the confirmed store when its turn starts. */
export function useSettingsSave(restore: () => void) {
  const { t } = useTranslation();
  const writable = useSettingsWritable();
  const pending = useRef(Promise.resolve());
  const count = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [saving, setSaving] = useState(false);
  const save = (operation: () => Promise<void>): Promise<boolean> => {
    if (!writable || !mounted.current) return Promise.resolve(false);
    count.current += 1;
    setSaving(true);
    const result = pending.current.then(async () => {
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
        count.current -= 1;
        if (mounted.current) {
          restore();
          setSaving(count.current > 0);
        }
      }
    });
    pending.current = result.then(() => undefined);
    return result;
  };
  return { save, saving, writable };
}
