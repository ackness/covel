/**
 * DataService facade for game data CRUD operations.
 *
 * Two implementations:
 *   - RemoteDataService: delegates to server API (T3 commercial)
 *   - LocalDataService: uses IndexedDB in-browser (T1/T2 self-deploy / demo)
 *
 * LLM execution, config, and plugin APIs always go through the server
 * regardless of storage mode.
 */

import type { GeneratedWorldSaveTarget } from "./api.js";
import { LocalDataService } from "./data-service/local.js";
import { RemoteDataService } from "./data-service/remote.js";
import type { DataService } from "./data-service/types.js";
import {
  getStorageMode as getStorageModeFromFacade,
  setStorageMode as setStorageModeFromFacade,
  storageModeForServerStorage as storageModeForServerStorageFromFacade,
  type ServerStorageCapabilities,
  type StorageMode,
} from "./storage/index.js";

export type { DataService } from "./data-service/types.js";
export type { ServerStoreBackend, StorageMode } from "./storage/index.js";

export function storageModeForServerStorage(
  storage: ServerStorageCapabilities | null | undefined,
): StorageMode | null {
  return storageModeForServerStorageFromFacade(storage);
}

export function generatedWorldSaveTargetForStorageMode(
  mode: StorageMode | null | undefined,
): GeneratedWorldSaveTarget {
  if (mode === "local") return "return-only";
  if (mode === "remote") return "server-store";
  return "server-file";
}

export function getStorageMode(): StorageMode {
  return getStorageModeFromFacade();
}

export function setStorageMode(mode: StorageMode): void {
  setStorageModeFromFacade(mode);
}

let cachedService: DataService | null = null;
let cachedMode: StorageMode | null = null;

export function getDataService(): DataService {
  const mode = getStorageMode();
  if (cachedService && cachedMode === mode) return cachedService;
  cachedMode = mode;
  cachedService =
    mode === "local" ? new LocalDataService() : new RemoteDataService();
  return cachedService;
}

/** Reset cached service (call after mode switch). */
export function resetDataService(): void {
  cachedService = null;
  cachedMode = null;
}
