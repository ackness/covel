import { STORAGE_MODE_KEY } from "./legacy-keys.js";

export type StorageMode = "local" | "remote";
export type ServerStoreBackend = "memory" | "sqlite" | "pg";

export interface ServerStorageCapabilities {
  readonly data?: {
    readonly backend?: ServerStoreBackend;
    readonly frontendMode?: StorageMode;
  };
}

export function storageModeForServerStorage(
  storage: ServerStorageCapabilities | null | undefined,
): StorageMode | null {
  const mode = storage?.data?.frontendMode;
  return mode === "local" || mode === "remote" ? mode : null;
}

export function getStorageMode(): StorageMode {
  const val = localStorage.getItem(STORAGE_MODE_KEY);
  return val === "local" ? "local" : "remote";
}

export function setStorageMode(mode: StorageMode): void {
  localStorage.setItem(STORAGE_MODE_KEY, mode);
}
