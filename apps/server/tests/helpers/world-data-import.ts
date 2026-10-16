import type { MediaStore, StoreTransaction } from "@covel/store";
import {
  applyPreparedWorldDataImportForSession,
  prepareWorldDataImportForSession,
} from "../../src/world-data/session-import.js";
import type {
  ImportWorldDataForSessionResult,
  WorldDataImportPreflightDeps,
} from "../../src/world-data/session-import/types.js";

interface ImportWorldDataForSessionOptions {
  readonly store: StoreTransaction;
  readonly mediaStore?: MediaStore;
  readonly sessionId: string;
  readonly worldId: string | undefined;
  readonly worldsDirs?: readonly string[];
  readonly covelHome?: string;
  readonly now: string;
  readonly preflight?: WorldDataImportPreflightDeps;
  readonly deferMediaFinalize?: boolean;
  /** Session locale — selects `<name>.<lang>.<ext>` source variants when present. */
  readonly locale?: string;
}

export async function importWorldDataForSession(
  options: ImportWorldDataForSessionOptions,
): Promise<ImportWorldDataForSessionResult> {
  const session =
    (!options.preflight?.activePlugins || options.locale === undefined) &&
    options.store.getSession
      ? await options.store.getSession(options.sessionId)
      : null;
  const prepared = await prepareWorldDataImportForSession({
    world: options.worldId
      ? await options.store.getWorld(options.worldId)
      : undefined,
    sessionId: options.sessionId,
    worldId: options.worldId,
    worldsDirs: options.worldsDirs,
    covelHome: options.covelHome,
    now: options.now,
    // Select skipExisting writes before materializing media in the apply step.
    preflight: {
      ...options.preflight,
      activePlugins: options.preflight?.activePlugins ?? session?.activePlugins,
    },
    locale: options.locale ?? session?.locale,
  });
  return applyPreparedWorldDataImportForSession({
    store: options.store,
    mediaStore: options.mediaStore,
    sessionId: options.sessionId,
    worldId: options.worldId,
    now: options.now,
    prepared,
    deferMediaFinalize: options.deferMediaFinalize,
  });
}
