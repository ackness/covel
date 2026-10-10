/**
 * Which stored media each current session still uses.
 *
 * One scan serves the operator cleanup endpoint and the player's media
 * library. A media ID counts as used by a session when the session owns the
 * asset, holds an explicit reference to it, or names it anywhere in its
 * messages, plugin data, runtime outputs, trace events, snapshots or turn
 * results.
 */

import { collectMediaRefIds } from "@covel/shared";
import type {
  DataStore,
  MediaAssetRecord,
  MediaStore,
  SessionRecord,
} from "@covel/store";

/**
 * Default per-session row scan ceiling of the cleanup endpoint. Each row in
 * {messages, plugin-data, runtime-outputs, trace-events, snapshots,
 * turn-results} contributes; once the running total exceeds the ceiling the
 * scan stops and reports the session instead of silently truncating (which
 * would risk deleting still-referenced media).
 */
export const DEFAULT_SCAN_LIMIT_PER_SESSION = 1_000;

/** Page size for scans; keeps each store call below the row ceiling. */
const SCAN_PAGE_SIZE = 100;

/** Maximum sessions per batch when iterating large installs. */
const SESSION_BATCH_SIZE = 50;

/** Threshold above which we batch + log progress. */
const LARGE_SESSION_INSTALL = 100;

export interface MediaReferenceScanOptions {
  readonly maxScanRowsPerSession?: number;
}

export interface MediaReferenceScan {
  /** Stored assets at the time of the scan (no bytes). */
  readonly assets: readonly MediaAssetRecord[];
  /** Sessions that existed at the time of the scan. */
  readonly sessions: readonly SessionRecord[];
  /** Media ID → the current sessions that use it. */
  readonly usedBy: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Assets with an owner or a reference that is not a current session: the
   * temporary claim of a world-data import in progress, or a claim that
   * outlived its session. The store never reclaims these on its own.
   */
  readonly heldIds: ReadonlySet<string>;
  readonly scannedSessions: number;
  /** True when a session had more rows than the ceiling; `usedBy` is partial. */
  readonly limitExceeded: boolean;
  readonly limitExceededSessionId?: string;
  readonly limitExceededRowCount?: number;
}

export async function scanMediaReferences(
  store: DataStore,
  mediaStore: MediaStore,
  options: MediaReferenceScanOptions = {},
): Promise<MediaReferenceScan> {
  const usedBy = new Map<string, Set<string>>();
  const heldIds = new Set<string>();
  const sessions = await store.listSessions();
  const liveSessionIds = new Set(sessions.map((session) => session.id));
  const assets = await mediaStore.listAssets();

  const use = (mediaId: string, sessionId: string): void => {
    let users = usedBy.get(mediaId);
    if (!users) {
      users = new Set<string>();
      usedBy.set(mediaId, users);
    }
    users.add(sessionId);
  };
  const claim = (mediaId: string, holder: string): void => {
    if (liveSessionIds.has(holder)) use(mediaId, holder);
    else heldIds.add(mediaId);
  };

  for (const asset of assets) {
    if (asset.ownerSessionId) claim(asset.id, asset.ownerSessionId);
  }
  for (const ref of await mediaStore.listRefs()) {
    claim(ref.mediaId, ref.sessionId);
  }

  const maxRowsPerSession =
    options.maxScanRowsPerSession ?? DEFAULT_SCAN_LIMIT_PER_SESSION;
  const pageSize = Math.max(1, Math.min(SCAN_PAGE_SIZE, maxRowsPerSession));
  const totalSessions = sessions.length;
  const shouldBatch = totalSessions > LARGE_SESSION_INSTALL;

  let scannedSessions = 0;
  const result = (exceeded?: {
    readonly sessionId: string;
    readonly rowCount: number;
  }): MediaReferenceScan => ({
    assets,
    sessions,
    usedBy,
    heldIds,
    scannedSessions,
    limitExceeded: exceeded !== undefined,
    ...(exceeded
      ? {
          limitExceededSessionId: exceeded.sessionId,
          limitExceededRowCount: exceeded.rowCount,
        }
      : {}),
  });

  for (
    let batchStart = 0;
    batchStart < totalSessions;
    batchStart += SESSION_BATCH_SIZE
  ) {
    const batch = sessions.slice(batchStart, batchStart + SESSION_BATCH_SIZE);
    for (const session of batch) {
      let rowsForSession = 0;
      /** Returns false when the session exceeds its row ceiling. */
      const scanRows = (rows: readonly unknown[]): boolean => {
        rowsForSession += rows.length;
        if (rowsForSession > maxRowsPerSession) return false;
        for (const id of collectMediaRefIds(rows)) use(id, session.id);
        return true;
      };
      const scanPaged = async (
        loader: (pagination: {
          readonly limit: number;
          readonly offset: number;
        }) => Promise<readonly unknown[]>,
      ): Promise<boolean> => {
        for (let offset = 0; ; offset += pageSize) {
          const rows = await loader({ limit: pageSize, offset });
          if (!scanRows(rows)) return false;
          if (rows.length < pageSize) return true;
        }
      };

      const complete =
        (await scanPaged((pagination) =>
          store.listMessages(session.id, pagination),
        )) &&
        (await scanPaged((pagination) =>
          store.listPluginDataSessionScope(session.id, pagination),
        )) &&
        (await scanPaged((pagination) =>
          store.listRuntimeOutputs(session.id, pagination),
        )) &&
        (await scanPaged((pagination) =>
          store.listTraceEvents(session.id, pagination),
        )) &&
        scanRows(await store.listSnapshots(session.id)) &&
        // Each turn row embeds that execution's full runtime results.
        scanRows(await store.listTurnResults(session.id));
      if (!complete) {
        return result({ sessionId: session.id, rowCount: rowsForSession });
      }

      scannedSessions += 1;
    }

    if (shouldBatch) {
      // Coarse progress signal for large installs. Stays at console.info so
      // it surfaces in pino's structured stream without triggering the
      // production no-console-log rule (this is operational telemetry, not
      // ad-hoc debugging).
      console.info(
        `[media-scan] scanned ${scannedSessions}/${totalSessions} sessions`,
      );
    }
  }

  return result();
}
