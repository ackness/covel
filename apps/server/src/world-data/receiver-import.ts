import type {
  WorldDataImportNotice,
  WorldDataReceiverImport,
} from "@covel/shared";
import type { DataStore, MediaStore } from "@covel/store";
import {
  prepareWorldDataSyncForSession,
  syncWorldDataForSession,
} from "./session-import.js";
import type { WorldDataImportPreflightDeps } from "./session-import/types.js";
import type { WorldDataDiagnostic } from "./types.js";

/**
 * The findings of an import that tell the player data is missing. Locale
 * file findings and notes stay with the world's author.
 */
export function worldDataImportNotices(
  diagnostics: readonly WorldDataDiagnostic[],
): WorldDataImportNotice[] {
  return diagnostics.flatMap((diagnostic) =>
    diagnostic.level === "info" || diagnostic.localeOverlay
      ? []
      : [
          {
            level: diagnostic.level,
            ...(diagnostic.sourceId ? { sourceId: diagnostic.sourceId } : {}),
            ...(diagnostic.code ? { code: diagnostic.code } : {}),
            message: diagnostic.message,
          },
        ],
  );
}

/**
 * Import the world's data once for plugins that joined a running session: a
 * community plugin the player approved after the game started, or any plugin
 * turned on later. Session creation skipped what they receive, because they
 * were not active then.
 *
 * Only joined plugins with no import ledger rows for this world receive data,
 * so turning a plugin off and on again does not re-import over what the game
 * changed. Their rows are the only ones written; the rest of the session is
 * left as it is. Projection code of a community plugin runs only with its
 * session grant (`preflight.canExecuteProjection`).
 */
export async function importWorldDataForJoinedPlugins(options: {
  readonly store: DataStore;
  readonly mediaStore?: MediaStore;
  readonly session: {
    readonly id: string;
    readonly worldId?: string;
    readonly locale?: string;
  };
  readonly joined: readonly string[];
  readonly worldsDirs?: readonly string[];
  readonly covelHome?: string;
  readonly now: string;
  readonly preflight: WorldDataImportPreflightDeps & {
    readonly activePlugins: readonly string[];
  };
}): Promise<WorldDataReceiverImport | undefined> {
  const { session } = options;
  const worldId = session.worldId;
  if (!worldId || options.joined.length === 0) return undefined;
  const ledgers = await options.store.listWorldDataImportLedger(session.id);
  const receivers = options.joined.filter(
    (pluginId) =>
      !ledgers.some(
        (ledger) =>
          ledger.pluginId === pluginId && ledger.sourceWorldId === worldId,
      ),
  );
  const sync = {
    store: options.store,
    mediaStore: options.mediaStore,
    sessionId: session.id,
    worldId,
    worldsDirs: options.worldsDirs,
    covelHome: options.covelHome,
    now: options.now,
    locale: session.locale,
    preflight: options.preflight,
    receivers,
  };
  const prepared = await prepareWorldDataSyncForSession(sync);
  const result =
    receivers.length > 0
      ? await syncWorldDataForSession({ ...sync, prepared })
      : undefined;
  const received = new Set(
    prepared.plan.writes.flatMap((write) =>
      "pluginId" in write && receivers.includes(write.pluginId)
        ? [write.pluginId]
        : [],
    ),
  );
  return {
    receivers: receivers.filter((pluginId) => received.has(pluginId)),
    imported: result?.upserted ?? 0,
    conflicts: result?.conflicts.length ?? 0,
    notices: worldDataImportNotices(prepared.diagnostics),
  };
}
