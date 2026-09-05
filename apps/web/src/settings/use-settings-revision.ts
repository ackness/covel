import { useEffect, useState } from "react";
import { getSettings } from "./store.js";

/** React to persisted changes and remote synchronization in composite panes. */
export function useSettingsRevision(keys: readonly string[]): number {
  const [revision, setRevision] = useState(0);
  const keyList = keys.join("\n");
  useEffect(() => {
    const watched = new Set(keyList.split("\n"));
    return getSettings().subscribeAll((_value, key) => {
      if (watched.has(key)) setRevision((previous) => previous + 1);
    });
  }, [keyList]);
  return revision;
}
