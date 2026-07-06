import { useState } from "react";

/**
 * Shared open/initial-key state for the SettingsDialog. Closing always clears
 * the initial key so the next open starts on the default pane.
 */
export function useSettingsDialog(onClose?: () => void) {
  const [open, setOpen] = useState(false);
  const [initialKey, setInitialKey] = useState<string | undefined>(undefined);

  const openWithKey = (key: string) => {
    setInitialKey(key);
    setOpen(true);
  };

  const onOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v) {
      setInitialKey(undefined);
      onClose?.();
    }
  };

  return { open, setOpen, initialKey, openWithKey, onOpenChange };
}
