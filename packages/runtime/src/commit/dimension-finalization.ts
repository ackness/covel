import { compareText } from "@covel/shared";
import {
  DIMENSION_CONTRACT,
  DIMENSION_DATA_NAMESPACE,
  DIMENSION_SETTLEMENT_NAMESPACE,
  dimensionRecordSchema,
  dimensionSnapshotSchema,
  dimensionSettlementReceiptSchema,
  resolveI18nText,
  type DimensionRecord,
  type DimensionSettlementReceipt,
  type WorldDimensionDefinition,
  type JsonValue,
  type Proposal,
  type RuntimeManifest,
  type SessionEvent,
} from "@covel/shared";
import type { StoreTransaction } from "@covel/store";

interface DimensionFinalizationResult {
  readonly runtimeId: string;
  readonly turnId: string;
  readonly runId?: string;
  readonly status: string;
  readonly output: Record<string, unknown> | null;
  readonly canonicalValue?: { readonly value?: JsonValue };
}

/**
 * Definitions a settlement receipt freezes. Only rule-bearing dimensions can be
 * settled, so static lore definitions are not copied into every receipt.
 */
export function settlementDefinitions(
  records: Readonly<Record<string, DimensionRecord>>,
  locale: string | undefined,
): Record<string, WorldDimensionDefinition> {
  return Object.fromEntries(
    Object.entries(records)
      .filter(([, record]) =>
        resolveI18nText(record.definition.updateRule, locale)?.trim(),
      )
      .map(([id, record]) => [id, record.definition]),
  );
}

/** The dimension provider one execution commits against. */
export interface DimensionSettlementScope {
  readonly provider: string;
  /** Runtime that publishes the provider's dimension snapshot. */
  readonly publisher: string;
  readonly locale: string | undefined;
  /** Player turn the narratives of this execution belong to. */
  readonly turnNumber: number;
}

type DimensionRuntime = Pick<
  RuntimeManifest,
  "name" | "pluginId" | "outputKind" | "outputContract"
>;

/**
 * Resolved receipts kept per session. After its turn a receipt is read only
 * for the idempotent re-commit of that same source and for the recent-history
 * display, so a short tail is enough; unresolved receipts are never pruned.
 * Without a bound every snapshot build reads and parses one row per turn.
 */
const RESOLVED_RECEIPTS_KEPT = 20;

/** The narrative a settlement update refers to, when it names one. */
function settlementSourceOf(
  proposal: Proposal,
): { readonly resultId: string } | undefined {
  if (proposal.type !== "dimension.update") return undefined;
  const payload: unknown = proposal.payload;
  if (!payload || typeof payload !== "object") return undefined;
  const source = (payload as { readonly source?: unknown }).source;
  return source && typeof source === "object"
    ? (source as { readonly resultId: string })
    : undefined;
}

/**
 * A settlement update needs its narrative's receipt to exist before it
 * commits; without one the commit handler records the update as unsettled debt.
 */
export function needsSettlementReceipt(proposal: Proposal): boolean {
  return settlementSourceOf(proposal) !== undefined;
}

/**
 * Bind the session to the dimension provider of this execution. The dimension
 * commit handlers reject a writer that is not the bound provider, so this runs
 * before any runtime commits. It writes no dimension data.
 */
export async function bindDimensionProvider(args: {
  readonly tx: StoreTransaction;
  readonly sessionId: string;
  readonly runtimes: readonly DimensionRuntime[];
}): Promise<DimensionSettlementScope | undefined> {
  const { tx, sessionId, runtimes } = args;
  const publishers = runtimes.filter(
    (runtime) => runtime.outputContract === DIMENSION_CONTRACT,
  );
  const providers = [...new Set(publishers.map((runtime) => runtime.pluginId))];
  if (providers.length > 1) throw new Error("Conflicting dimension providers");
  const provider = providers[0];
  if (!provider) return undefined;
  const session = await tx.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const previous = session.metadata?._dimensionProviderPluginId;
  if (previous !== undefined && previous !== provider)
    throw new Error(
      "Dimension provider changed; recreate the development session",
    );
  if (previous !== provider)
    await tx.updateSession(sessionId, {
      metadata: { _dimensionProviderPluginId: provider },
    });
  return {
    provider,
    publisher: publishers[0]!.name,
    locale: session.locale,
    turnNumber: session.completedPlayerTurns + 1,
  };
}

/** A producer that RAN and failed marks the receipt; an absent one does not. */
function sharedExtractionFailed(
  runtimes: readonly DimensionRuntime[],
  results: readonly DimensionFinalizationResult[],
): boolean {
  // IR is optional corroboration, never the settlement owner. A producer that
  // was skipped, not scheduled, or simply absent from this execution does not
  // poison the obligation — the tracker can still settle from the
  // authoritative narrative alone, and a later retry with a successful IR run
  // must be able to clear the flag.
  return runtimes
    .filter((runtime) => runtime.outputContract === "world-ir-provider@1")
    .some((producer) =>
      results.some(
        (result) =>
          result.runtimeId === producer.name && result.status === "failed",
      ),
    );
}

/**
 * Register the settlement obligation of every narrative in this execution.
 *
 * Receipts freeze the records `sink` can read, which are the committed ones:
 * initialization reaches the store only through its own proposal, inside the
 * savepoint of the runtime that proposed it. Call this where a receipt is
 * first needed and once more after the last runtime; a receipt that already
 * exists is left alone, and one registered inside a savepoint that rolls back
 * is registered again from what did commit.
 */
export async function registerDimensionSettlements(args: {
  readonly sink: StoreTransaction;
  readonly sessionId: string;
  readonly scope: DimensionSettlementScope;
  readonly runtimes: readonly DimensionRuntime[];
  readonly results: readonly DimensionFinalizationResult[];
}): Promise<readonly SessionEvent[]> {
  const { sink, sessionId, scope, runtimes, results } = args;
  const { provider } = scope;
  const rows = await sink.listPluginData(
    sessionId,
    provider,
    DIMENSION_DATA_NAMESPACE,
  );
  const records = Object.fromEntries(
    rows.map((row) => [row.key, dimensionRecordSchema.parse(row.value)]),
  );
  if (
    !Object.values(records).some((record) =>
      resolveI18nText(record.definition.updateRule, scope.locale)?.trim(),
    )
  )
    return [];
  const events: SessionEvent[] = [];
  const published = results.find(
    (result) =>
      result.runtimeId === scope.publisher && result.status === "success",
  );
  const snapshot = published
    ? dimensionSnapshotSchema.parse(
        published.canonicalValue?.value ?? published.output,
      )
    : undefined;
  // `records` is the authoritative committed store view, INCLUDING same-
  // transaction initialization the tracker legitimately settles against. The
  // published snapshot is a same-transaction projection that may lag or omit
  // rows (a just-initialized dimension is not in it), so it must not overwrite
  // the authoritative baseline. readVersions therefore comes from records;
  // snapshot only ADDS ids it knows that records lacks.
  const readVersions = Object.fromEntries(
    Object.entries({ ...snapshot, ...records }).map(([id, record]) => [
      id,
      record.version,
    ]),
  );
  const kinds = new Map(
    runtimes.map((runtime) => [runtime.name, runtime.outputKind]),
  );
  const irFailed = sharedExtractionFailed(runtimes, results);
  const now = new Date().toISOString();
  for (const result of results) {
    if (kinds.get(result.runtimeId) !== "story" || result.status !== "success")
      continue;
    if (!result.runId)
      throw new Error(
        "Dimension settlement requires a server narrative result ID",
      );
    const receipt: DimensionSettlementReceipt = {
      source: {
        resultId: result.runId,
        turnNumber: scope.turnNumber,
      },
      status: "pending-settlement",
      readVersions,
      definitions: settlementDefinitions(records, scope.locale),
      sourceTurnId: result.turnId,
      version: 1,
      ...(irFailed
        ? {
            error: "Shared WorldIR extraction failed",
            blockedBy: "extraction-failed" as const,
          }
        : {}),
    };
    const created = await sink.compareAndSetPluginDataBatch(
      sessionId,
      provider,
      [
        {
          namespace: DIMENSION_SETTLEMENT_NAMESPACE,
          key: result.runId,
          expectedVersion: null,
          value: receipt,
          timestamp: now,
        },
      ],
    );
    if (created) {
      // The event bus records the event when finalize publishes it after
      // commit; saving it here too collided on the same event id.
      events.push({
        id: crypto.randomUUID(),
        type: "dimensions.settlement.changed",
        sessionId,
        turnId: result.turnId,
        source: { pluginId: provider, runtimeId: scope.publisher },
        timestamp: now,
        payload: {
          providerPluginId: provider,
          source: receipt.source,
          sourceTurnId: receipt.sourceTurnId,
          version: receipt.version,
          status: "pending-settlement",
          ...(receipt.error ? { error: receipt.error } : {}),
        },
      });
    }
  }
  if (events.length > 0) await pruneResolvedReceipts(sink, sessionId, provider);
  return events;
}

/** Delete resolved receipts older than the newest {@link RESOLVED_RECEIPTS_KEPT}. */
async function pruneResolvedReceipts(
  sink: StoreTransaction,
  sessionId: string,
  provider: string,
): Promise<void> {
  const rows = await sink.listPluginData(
    sessionId,
    provider,
    DIMENSION_SETTLEMENT_NAMESPACE,
  );
  // Oldest first by creation time, whatever order the backend lists in. A row
  // that does not parse is left alone: cleanup must not fail the commit.
  const resolved = rows
    .filter((row) => {
      const receipt = dimensionSettlementReceiptSchema.safeParse(row.value);
      return receipt.success && receipt.data.status !== "pending-settlement";
    })
    .sort((a, b) => compareText(a.createdAt, b.createdAt));
  for (const row of resolved.slice(
    0,
    Math.max(0, resolved.length - RESOLVED_RECEIPTS_KEPT),
  ))
    await sink.deletePluginData(
      sessionId,
      provider,
      DIMENSION_SETTLEMENT_NAMESPACE,
      row.key,
    );
}

/**
 * An explicit scoped retry re-evaluates the same source against a new,
 * version-checked read set; it never reuses an old absolute update plan. The
 * pending receipt adopts the read set of each accepted retry update, in the
 * same savepoint that then commits the update.
 */
export async function adoptRetryReadSets(args: {
  readonly sink: StoreTransaction;
  readonly sessionId: string;
  readonly scope: DimensionSettlementScope;
  readonly runtimes: readonly DimensionRuntime[];
  readonly results: readonly DimensionFinalizationResult[];
  readonly proposals: readonly Proposal[];
}): Promise<void> {
  const { sink, sessionId, scope } = args;
  const irFailed = sharedExtractionFailed(args.runtimes, args.results);
  const now = new Date().toISOString();
  for (const proposal of args.proposals) {
    const source = settlementSourceOf(proposal);
    if (!source || proposal.type !== "dimension.update") continue;
    if (
      proposal.payload.settlement === "manual" ||
      proposal.payload.settlement === "skipped"
    )
      continue;
    const row = await sink.getPluginData(
      sessionId,
      scope.provider,
      DIMENSION_SETTLEMENT_NAMESPACE,
      source.resultId,
    );
    if (!row) continue;
    const receipt = dimensionSettlementReceiptSchema.parse(row.value);
    if (receipt.status !== "pending-settlement") continue;
    if (receipt.blockedBy === "extraction-failed" && irFailed) continue;
    const { error: _error, blockedBy: _blockedBy, ...clean } = receipt;
    await sink.compareAndSetPluginDataBatch(sessionId, scope.provider, [
      {
        namespace: DIMENSION_SETTLEMENT_NAMESPACE,
        key: receipt.source.resultId,
        expectedVersion: receipt.version,
        value: {
          ...clean,
          readVersions: proposal.payload.readVersions,
          version: receipt.version + 1,
        },
        timestamp: now,
      },
    ]);
  }
}
