/**
 * API Trace routes — read-only endpoints for debug trace inspection.
 */

import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { mediaRefSchema, type MediaRef } from '@covel/shared';
import type { DataStore, TraceEventRecord } from '@covel/store';

type Env = {
  Variables: {
    store: DataStore;
  };
};

export const traceRoutes = new Hono<Env>();

// GET /:sessionId — list all trace events for a session
traceRoutes.get('/:sessionId', async (c) => {
  const store = c.get('store');
  const sessionId = c.req.param('sessionId');

  const events = await listTraceEventsWithLegacyAssets(store, sessionId);

  return c.json({
    sessionId,
    count: events.length,
    events: events.map(toApiTraceEvent),
  });
});

// GET /:sessionId/turns — trace events grouped by turn
traceRoutes.get('/:sessionId/turns', async (c) => {
  const store = c.get('store');
  const sessionId = c.req.param('sessionId');

  const events = await listTraceEventsWithLegacyAssets(store, sessionId);

  // Group events by turnId
  const turnMap = new Map<string, TraceEventRecord[]>();
  for (const evt of events) {
    const turnId = evt.turnId || '__unknown__';
    const arr = turnMap.get(turnId);
    if (arr) {
      arr.push(evt);
    } else {
      turnMap.set(turnId, [evt]);
    }
  }

  // Build turn summaries sorted by first event timestamp
  const turns = Array.from(turnMap.entries())
    .map(([turnId, turnEvents]) => {
      const sorted = turnEvents.sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt)
      );
      const firstEvt = sorted[0];
      const lastEvt = sorted[sorted.length - 1];
      const payload = firstEvt.payload as Record<string, unknown> | null;
      const flowId = (payload?.flowId as string) ?? '';
      const traceId = firstEvt.traceId ?? '';

      return {
        turnId,
        flowId,
        traceId,
        startedAt: firstEvt.createdAt,
        completedAt: lastEvt.createdAt,
        eventCount: sorted.length,
        events: sorted.map(toApiTraceEvent),
      };
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  return c.json({
    sessionId,
    turnCount: turns.length,
    turns,
  });
});

/**
 * Map a store TraceEventRecord to the shape expected by the frontend API client.
 */
function toApiTraceEvent(record: TraceEventRecord) {
  const payload = (record.payload ?? {}) as Record<string, unknown>;
  return {
    type: record.type,
    requestId: (payload.requestId as string) ?? '',
    traceId: record.traceId ?? '',
    sessionId: record.sessionId,
    turnId: record.turnId ?? '',
    flowId: (payload.flowId as string) ?? '',
    seq: (payload.seq as number) ?? 0,
    timestamp: record.createdAt,
    payload,
  };
}

async function listTraceEventsWithLegacyAssets(
  store: DataStore,
  sessionId: string,
): Promise<TraceEventRecord[]> {
  const events = await store.listTraceEvents(sessionId);
  const legacyAssetEvents = await buildLegacyAssetEvents(store, sessionId, events);
  return [...events, ...legacyAssetEvents].sort(compareTraceEvents);
}

function compareTraceEvents(a: TraceEventRecord, b: TraceEventRecord): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

interface LegacyAssetCandidate {
  readonly ref: MediaRef;
  readonly modality: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly turnId: string;
  readonly createdAt: string;
  readonly source: string;
  readonly sourceKey: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

async function buildLegacyAssetEvents(
  store: DataStore,
  sessionId: string,
  existingEvents: readonly TraceEventRecord[],
): Promise<TraceEventRecord[]> {
  const seen = existingAssetKeys(existingEvents);
  const candidates: LegacyAssetCandidate[] = [];

  for (const row of await store.listPluginDataSessionScope(sessionId)) {
    if (row.namespace !== 'images') continue;
    candidates.push(...extractLegacyImageCandidates(row.value, {
      sessionId,
      pluginId: row.pluginId,
      runtimeId: row.pluginId,
      turnId: inferTurnId(row.value) ?? '__legacy__',
      createdAt: row.updatedAt,
      source: 'plugin_data',
      sourceKey: `${row.pluginId}/${row.namespace}/${row.key}`,
      assumeImage: true,
    }));
  }

  const turnResults = await store.listTurnResults(sessionId);
  for (const turn of turnResults) {
    const runtimeResults = await store.listRuntimeResults(sessionId, turn.turnId);
    for (const result of runtimeResults) {
      candidates.push(...extractLegacyImageCandidates(result.output, {
        sessionId,
        pluginId: result.pluginId,
        runtimeId: result.runtimeId,
        turnId: result.turnId,
        createdAt: result.createdAt,
        source: 'runtime_results',
        sourceKey: result.id,
        assumeImage: false,
      }));
    }
    candidates.push(...extractLegacyImageCandidates(turn.runtimeResults, {
      sessionId,
      pluginId: 'legacy',
      runtimeId: 'legacy',
      turnId: turn.turnId,
      createdAt: turn.createdAt,
      source: 'turn_results',
      sourceKey: turn.id,
      assumeImage: false,
    }));
  }

  for (const output of await store.listRuntimeOutputs(sessionId)) {
    candidates.push(...extractLegacyImageCandidates(output.results, {
      sessionId,
      pluginId: output.pluginId,
      runtimeId: output.runtimeId,
      turnId: output.turnId,
      createdAt: output.createdAt,
      source: 'runtime_outputs',
      sourceKey: output.id,
      assumeImage: false,
    }));
  }

  const events: TraceEventRecord[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.turnId}:${candidate.ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(toLegacyAssetEvent(sessionId, candidate));
  }
  return events;
}

function existingAssetKeys(events: readonly TraceEventRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const event of events) {
    if (event.type !== 'asset.generated') continue;
    const payload = asRecord(event.payload);
    const asset = asRecord(payload?.asset);
    const ref = asset ? mediaRefSchema.safeParse(asset.ref) : null;
    if (ref?.success) {
      keys.add(`${event.turnId}:${ref.data.id}`);
    }
  }
  return keys;
}

function toLegacyAssetEvent(sessionId: string, candidate: LegacyAssetCandidate): TraceEventRecord {
  const source = {
    pluginId: candidate.pluginId,
    runtimeId: candidate.runtimeId,
  };
  const asset = {
    id: `legacy-${hashHex(`${candidate.source}:${candidate.sourceKey}:${candidate.ref.id}`)}`,
    type: 'asset.generate',
    sessionId,
    turnId: candidate.turnId,
    source,
    ref: candidate.ref,
    modality: candidate.modality,
    meta: {
      ...candidate.meta,
      legacy: true,
      legacySource: candidate.source,
      legacySourceKey: candidate.sourceKey,
    },
    createdAt: candidate.createdAt,
  };

  return {
    id: `legacy-trace-${hashHex(`${sessionId}:${candidate.turnId}:${candidate.source}:${candidate.sourceKey}:${candidate.ref.id}`)}`,
    sessionId,
    type: 'asset.generated',
    traceId: `legacy-${sessionId}`,
    turnId: candidate.turnId,
    payload: {
      runtimeId: candidate.runtimeId,
      pluginId: candidate.pluginId,
      proposalId: asset.id,
      legacy: true,
      legacySource: candidate.source,
      asset,
    },
    createdAt: candidate.createdAt,
  };
}

interface LegacyScanContext {
  readonly sessionId: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly turnId: string;
  readonly createdAt: string;
  readonly source: string;
  readonly sourceKey: string;
  readonly assumeImage: boolean;
}

function extractLegacyImageCandidates(
  value: unknown,
  ctx: LegacyScanContext,
): LegacyAssetCandidate[] {
  const candidates: LegacyAssetCandidate[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    const record = node as Record<string, unknown>;
    const ref = legacyMediaRef(record, ctx.assumeImage);
    if (ref) {
      candidates.push({
        ref,
        modality: stringField(record, ['modality', 'assetType', 'kind']) ?? 'image',
        pluginId: stringField(record, ['pluginId']) ?? ctx.pluginId,
        runtimeId: stringField(record, ['runtimeId']) ?? ctx.runtimeId,
        turnId: stringField(record, ['turnId']) ?? ctx.turnId,
        createdAt: stringField(record, ['createdAt', 'updatedAt', 'timestamp']) ?? ctx.createdAt,
        source: ctx.source,
        sourceKey: ctx.sourceKey,
        meta: recordField(record, 'meta'),
      });
      return;
    }

    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return candidates;
}

function legacyMediaRef(record: Record<string, unknown>, assumeImage: boolean): MediaRef | null {
  const directRef = mediaRefSchema.safeParse(record.ref);
  if (directRef.success) return directRef.data;

  const mediaRef = mediaRefSchema.safeParse(record.mediaRef);
  if (mediaRef.success) return mediaRef.data;

  const mime = stringField(record, ['mime', 'contentType', 'mediaType']) ?? 'image/png';
  const modality = stringField(record, ['modality', 'assetType', 'kind', 'type']);
  const imageLike = assumeImage || mime.startsWith('image/') || modality === 'image';

  const dataUrl = stringField(record, ['dataUrl', 'dataURI']);
  if (dataUrl && dataUrl.startsWith('data:')) {
    return mediaRefFromUrl(dataUrl, mimeFromDataUrl(dataUrl) ?? mime, byteSizeFromDataUrl(dataUrl), record);
  }

  const base64 = stringField(record, ['base64', 'b64']);
  if (base64 && imageLike) {
    const normalized = base64.replace(/\s+/g, '');
    const dataMime = mime.startsWith('image/') ? mime : 'image/png';
    return mediaRefFromUrl(
      `data:${dataMime};base64,${normalized}`,
      dataMime,
      byteSizeFromBase64(normalized),
      record,
    );
  }

  const imageUrl = stringField(record, ['imageUrl', 'image_url']);
  if (imageUrl) {
    return mediaRefFromUrl(imageUrl, mime, 0, record);
  }

  const url = stringField(record, ['url']);
  if (url && imageLike) {
    return mediaRefFromUrl(url, mime, 0, record);
  }

  return null;
}

function mediaRefFromUrl(
  url: string,
  mime: string,
  size: number,
  record: Record<string, unknown>,
): MediaRef | null {
  try {
    new URL(url);
  } catch {
    return null;
  }

  const ref: MediaRef = {
    id: hashHex(url),
    mime,
    size,
    url,
    meta: {
      legacy: true,
      ...(recordField(record, 'meta') ?? {}),
    },
  };
  return mediaRefSchema.safeParse(ref).success ? ref : null;
}

function inferTurnId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = inferTurnId(item);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const direct = stringField(record, ['turnId']);
  if (direct) return direct;
  for (const child of Object.values(record)) {
    const found = inferTurnId(child);
    if (found) return found;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function recordField(
  record: Record<string, unknown>,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  const value = record[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function stringField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function mimeFromDataUrl(dataUrl: string): string | undefined {
  return /^data:([^;,]+)[;,]/i.exec(dataUrl)?.[1]?.toLowerCase();
}

function byteSizeFromDataUrl(dataUrl: string): number {
  const base64 = dataUrl.split(',', 2)[1] ?? '';
  return byteSizeFromBase64(base64);
}

function byteSizeFromBase64(base64: string): number {
  const trimmed = base64.replace(/=+$/, '');
  return Math.floor((trimmed.length * 3) / 4);
}

function hashHex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
