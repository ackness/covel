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

/** Queue mechanics shared by settings controls and the model panes. */
export function useSettingsSaveQueue({
  initiallyMounted = false,
}: { initiallyMounted?: boolean } = {}) {
  const queue = useRef(Promise.resolve());
  const pending = useRef(0);
  const mounted = useRef(initiallyMounted);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [saving, setSaving] = useState(false);
  const enqueue = async <T>(
    operation: () => Promise<T>,
    onSettled?: () => void,
  ): Promise<T> => {
    const previous = queue.current;
    let release!: () => void;
    queue.current = new Promise<void>((resolve) => {
      release = resolve;
    });
    pending.current += 1;
    setSaving(true);
    await previous;
    try {
      return await operation();
    } finally {
      pending.current -= 1;
      release();
      if (mounted.current) {
        onSettled?.();
        setSaving(pending.current > 0);
      }
    }
  };
  return { enqueue, saving, mounted, pending };
}

/** Serialize edits; each operation reads the confirmed store when its turn starts. */
export function useSettingsSave(restore: () => void) {
  const { t } = useTranslation();
  const writable = useSettingsWritable();
  const { enqueue, saving, mounted } = useSettingsSaveQueue({
    initiallyMounted: true,
  });
  const save = (operation: () => Promise<void>): Promise<boolean> => {
    if (!writable || !mounted.current) return Promise.resolve(false);
    return enqueue(async () => {
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
      }
    }, restore);
  };
  return { save, saving, writable };
}
