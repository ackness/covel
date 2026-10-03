import {
  DIMENSION_CONTRACT,
  DIMENSION_DATA_NAMESPACE,
  DIMENSION_SETTLEMENT_NAMESPACE,
  dimensionRecordSchema,
  materializeDimensionRecords,
  dimensionSnapshotSchema,
  dimensionSettlementReceiptSchema,
  resolveI18nText,
  type DimensionRecord,
  type DimensionSettlementReceipt,
  type WorldDimensionDefinition,
  type ExecutionContext,
  type JsonValue,
  type Proposal,
  type RuntimeManifest,
  type SessionEvent,
} from "@covel/shared";
import type { StoreTransaction } from "@covel/store";

interface DimensionFinalizationResult {
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly turnId: string;
  readonly runId?: string;
  readonly status: string;
  readonly output: Record<string, unknown> | null;
  readonly canonicalValue?: { readonly value?: JsonValue };
  readonly pendingProposals?: readonly Proposal[];
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

/** Register narrative obligations inside the same transaction as narrative commit. */
export async function prepareDimensionFinalization(args: {
  readonly tx: StoreTransaction;
  readonly sessionId: string;
  readonly executionContext: ExecutionContext;
  readonly runtimes: readonly Pick<
    RuntimeManifest,
    "name" | "pluginId" | "outputKind" | "outputContract"
  >[];
  readonly results: readonly DimensionFinalizationResult[];
}): Promise<readonly SessionEvent[]> {
  const { tx, sessionId, runtimes, results } = args;
  const providers = [
    ...new Set(
      runtimes
        .filter((runtime) => runtime.outputContract === DIMENSION_CONTRACT)
        .map((runtime) => runtime.pluginId),
    ),
  ];
  if (providers.length > 1) throw new Error("Conflicting dimension providers");
  const provider = providers[0];
  if (!provider) return [];
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
  const rows = await tx.listPluginData(
    sessionId,
    provider,
    DIMENSION_DATA_NAMESPACE,
  );
  let records = Object.fromEntries(
    rows.map((row) => [row.key, dimensionRecordSchema.parse(row.value)]),
  );
  for (const result of results) {
    if (
      result.pluginId !== provider ||
      !["success", "skipped"].includes(result.status)
    )
      continue;
    for (const proposal of result.pendingProposals ?? []) {
      if (proposal.type !== "dimension.initialize") continue;
      const initialized = materializeDimensionRecords(
        records,
        proposal,
        session.locale,
      );
      const entries = Object.entries(initialized)
        .filter(([id]) => !records[id])
        .map(([key, value]) => ({
          namespace: DIMENSION_DATA_NAMESPACE,
          key,
          value,
          expectedVersion: null,
          timestamp: new Date().toISOString(),
        }));
      if (
        !(await tx.compareAndSetPluginDataBatch(sessionId, provider, entries))
      )
        throw new Error("Dimension initialization version conflict");
      records = { ...initialized };
    }
  }
  if (
    !Object.values(records).some((record) =>
      resolveI18nText(record.definition.updateRule, session.locale)?.trim(),
    )
  )
    return [];
  const events: SessionEvent[] = [];
  const publisher = runtimes.find(
    (runtime) =>
      runtime.pluginId === provider &&
      runtime.outputContract === DIMENSION_CONTRACT,
  );
  const published = results.find(
    (result) =>
      result.runtimeId === publisher?.name && result.status === "success",
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
  const irProducers = runtimes.filter(
    (runtime) => runtime.outputContract === "world-ir-provider@1",
  );
  // IR is optional corroboration, never the settlement owner. Only a producer
  // that RAN and failed (status "failed") marks the receipt's extraction
  // error. A producer that was skipped, not scheduled, or simply absent from
  // this execution does not poison the obligation — the tracker can still
  // settle from the authoritative narrative alone, and a later retry with a
  // successful IR run must be able to clear the flag.
  const irFailed = irProducers.some((producer) =>
    results.some(
      (result) =>
        result.runtimeId === producer.name && result.status === "failed",
    ),
  );
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
        turnNumber: session.completedPlayerTurns + 1,
      },
      status: "pending-settlement",
      readVersions,
      definitions: settlementDefinitions(records, session.locale),
      sourceTurnId: result.turnId,
      version: 1,
      ...(irFailed ? { error: "Shared WorldIR extraction failed" } : {}),
    };
    const created = await tx.compareAndSetPluginDataBatch(sessionId, provider, [
      {
        namespace: DIMENSION_SETTLEMENT_NAMESPACE,
        key: result.runId,
        expectedVersion: null,
        value: receipt,
        timestamp: now,
      },
    ]);
    if (created) {
      const event: SessionEvent = {
        id: crypto.randomUUID(),
        type: "dimensions.settlement.changed",
        sessionId,
        turnId: result.turnId,
        source: { pluginId: provider, runtimeId: publisher!.name },
        timestamp: now,
        payload: {
          providerPluginId: provider,
          source: receipt.source,
          sourceTurnId: receipt.sourceTurnId,
          version: receipt.version,
          status: "pending-settlement",
          ...(receipt.error ? { error: receipt.error } : {}),
        },
      };
      // The event bus records the event when finalize publishes it after
      // commit; saving it here too collided on the same event id.
      events.push(event);
    }
  }
  // An explicit scoped retry re-evaluates the same source against a new,
  // version-checked read set; it never reuses an old absolute update plan.
  if (
    args.executionContext.origin === "manual" &&
    args.executionContext.sourceTurnId
  ) {
    for (const result of results) {
      if (result.pluginId !== provider || result.status !== "success") continue;
      for (const proposal of result.pendingProposals ?? []) {
        if (
          proposal.type !== "dimension.update" ||
          !proposal.payload.source ||
          proposal.payload.settlement === "manual" ||
          proposal.payload.settlement === "skipped"
        )
          continue;
        const row = await tx.getPluginData(
          sessionId,
          provider,
          DIMENSION_SETTLEMENT_NAMESPACE,
          proposal.payload.source.resultId,
        );
        if (!row) continue;
        const receipt = dimensionSettlementReceiptSchema.parse(row.value);
        if (receipt.status !== "pending-settlement") continue;
        if (receipt.error === "Shared WorldIR extraction failed" && irFailed)
          continue;
        const { error: _error, ...clean } = receipt;
        await tx.compareAndSetPluginDataBatch(sessionId, provider, [
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
  }
  return events;
}
