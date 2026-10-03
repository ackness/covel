import {
  DIMENSION_DATA_NAMESPACE,
  DIMENSION_SETTLEMENT_NAMESPACE,
  DimensionConflictError,
  DimensionValidationError,
  dimensionRecordSchema,
  resolveI18nText,
  dimensionSettlementReceiptSchema,
  dimensionSnapshotFromRecords,
  dimensionUpdatePayloadSchema,
  dimensionsJsonEqual,
  materializeDimensionRecords,
  type CommitResult,
  type DimensionRecord,
  type ProposalFor,
} from "@covel/shared";
import type { PluginDataBatchCasEntry } from "@covel/store";
import { ZodError } from "zod";
import type { KernelStore } from "../session/session-kernel-store.js";
import type { CommitHandlerMap } from "./commit-handler-types.js";
import { commitError } from "./commit-validators.js";
import { settlementDefinitions } from "./dimension-finalization.js";

export function createDimensionCommitHandlers(
  store: KernelStore,
): Pick<CommitHandlerMap, "dimension.initialize" | "dimension.update"> {
  async function commit(
    proposal:
      ProposalFor<"dimension.initialize"> | ProposalFor<"dimension.update">,
  ): Promise<CommitResult> {
    if (
      !store.listPluginData ||
      !store.compareAndSetPluginDataBatch ||
      !store.getPluginData
    )
      return commitError("Dimension store unavailable");
    const pluginId = proposal.source.pluginId;
    const session = await store.getSession?.(proposal.sessionId);
    if (session?.metadata?._dimensionProviderPluginId !== pluginId)
      return commitError("Dimension writer is not the active provider");
    const rows = await store.listPluginData(
      proposal.sessionId,
      pluginId,
      DIMENSION_DATA_NAMESPACE,
    );
    const base: Record<string, DimensionRecord> = Object.fromEntries(
      rows.map((row) => [row.key, dimensionRecordSchema.parse(row.value)]),
    );
    const payload =
      proposal.type === "dimension.update"
        ? dimensionUpdatePayloadSchema.safeParse(proposal.payload)
        : undefined;
    const source =
      proposal.type === "dimension.update"
        ? proposal.payload.source
        : undefined;
    const receiptRow = source
      ? await store.getPluginData(
          proposal.sessionId,
          pluginId,
          DIMENSION_SETTLEMENT_NAMESPACE,
          source.resultId,
        )
      : null;
    const receipt = receiptRow
      ? dimensionSettlementReceiptSchema.parse(receiptRow.value)
      : undefined;
    const event = (
      type: string,
      data: Readonly<Record<string, unknown>>,
    ): CommitResult => ({
      committed: true,
      event: {
        id: crypto.randomUUID(),
        type,
        sessionId: proposal.sessionId,
        turnId: proposal.turnId,
        source: proposal.source,
        payload: { providerPluginId: pluginId, ...data },
        timestamp: proposal.timestamp,
      },
    });
    // A settlement update that references a narrative with no registered
    // receipt must NOT roll back the enclosing execution (and its committed
    // narrative) via commitError. The settlement obligation is host-owned;
    // instead of failing the proposal we register the missing obligation as
    // pending-settlement so the narrative commits and the debt stays visible.
    if (source && (!receipt || !dimensionsJsonEqual(receipt.source, source))) {
      const obligation = {
        source,
        status: "pending-settlement",
        readVersions: Object.fromEntries(
          Object.entries(base).map(([id, record]) => [id, record.version]),
        ),
        definitions: settlementDefinitions(base, session?.locale),
        sourceTurnId: proposal.turnId,
        version: 1,
        error: "Settlement source had no registered receipt; marked pending",
      };
      const registered = await store.compareAndSetPluginDataBatch!(
        proposal.sessionId,
        pluginId,
        [
          {
            namespace: DIMENSION_SETTLEMENT_NAMESPACE,
            key: source.resultId,
            expectedVersion: null,
            value: obligation,
            timestamp: proposal.timestamp,
          },
        ],
      );
      // Commit as a no-op (values untouched); the pending receipt keeps the
      // obligation visible and blocks the next dependent narrative. A row that
      // already exists under this key (mismatched source) is reported rather
      // than read as a settled no-op.
      if (!registered)
        return {
          committed: true,
          error: `Settlement source mismatch for ${source.resultId}; update not applied`,
        };
      return event("dimensions.settlement.changed", {
        source,
        status: "pending-settlement",
        sourceTurnId: obligation.sourceTurnId,
        version: obligation.version,
        error: obligation.error,
      });
    }
    if (receipt && receipt.status !== "pending-settlement")
      return { committed: true };

    const pending = async (message: string): Promise<CommitResult> => {
      if (!receipt) return commitError(message);
      const updated = {
        ...receipt,
        error: message,
        version: receipt.version + 1,
      };
      const applied = await store.compareAndSetPluginDataBatch!(
        proposal.sessionId,
        pluginId,
        [
          {
            namespace: DIMENSION_SETTLEMENT_NAMESPACE,
            key: receipt.source.resultId,
            expectedVersion: receipt.version,
            value: updated,
            timestamp: proposal.timestamp,
          },
        ],
      );
      if (!applied)
        // The settlement row moved under us (a concurrent retry/manual edit).
        // The narrative still commits — but surface that THIS pending mark was
        // not recorded so the caller doesn't read silence as "debt cleared".
        return {
          committed: true,
          error: `Settlement pending mark not recorded for ${receipt.source.resultId}: version moved`,
        };
      return event("dimensions.settlement.changed", {
        source: receipt.source,
        status: "pending-settlement",
        sourceTurnId: receipt.sourceTurnId,
        version: updated.version,
        error: message,
      });
    };
    try {
      if (payload && !payload.success) return pending(payload.error.message);
      if (
        receipt?.error === "Shared WorldIR extraction failed" &&
        payload?.data?.settlement !== "manual" &&
        payload?.data?.settlement !== "skipped"
      )
        return pending(receipt.error);
      if (payload?.success && receipt) {
        if (
          !dimensionsJsonEqual(
            payload.data.readVersions,
            receipt.readVersions,
          ) &&
          payload.data.settlement !== "manual" &&
          payload.data.settlement !== "skipped"
        )
          return pending(
            "Settlement read set does not match the frozen narrative snapshot",
          );
      }
      if (
        payload?.success &&
        payload.data.source &&
        !["manual", "skipped"].includes(payload.data.settlement ?? "")
      ) {
        for (const update of payload.data.updates) {
          if (
            !resolveI18nText(
              base[update.id]?.definition.updateRule,
              session?.locale,
            )?.trim()
          )
            throw new DimensionValidationError(
              `Dimension has no maintenance rule: ${update.id}`,
            );
        }
        if (
          receipt &&
          Object.entries(receipt.definitions).some(
            ([id, definition]) =>
              !dimensionsJsonEqual(definition, base[id]?.definition),
          )
        )
          throw new DimensionConflictError(
            "Adopted dimension definitions changed",
          );
      }
      const next = materializeDimensionRecords(base, proposal, session?.locale);
      const changed = Object.entries(next).filter(
        ([id, record]) => !dimensionsJsonEqual(base[id], record),
      );
      const entries: PluginDataBatchCasEntry[] = changed.map(
        ([key, value]) => ({
          namespace: DIMENSION_DATA_NAMESPACE,
          key,
          expectedVersion: base[key]?.version ?? null,
          value,
          timestamp: proposal.timestamp,
        }),
      );
      // Unchanged values that participated in evaluation must also pass CAS.
      for (const [id, version] of Object.entries(
        payload?.success ? (payload.data.readVersions ?? {}) : {},
      )) {
        if (!changed.some(([key]) => key === id))
          entries.push({
            namespace: DIMENSION_DATA_NAMESPACE,
            key: id,
            expectedVersion: version,
            value: base[id]!,
            timestamp: proposal.timestamp,
          });
      }
      let status: "settled" | "no-change" | "manual" | "skipped" | undefined;
      if (receipt && payload?.success) {
        status =
          payload.data.settlement ??
          (payload.data.updates.some(
            (update) =>
              !dimensionsJsonEqual(base[update.id]?.value, update.value),
          )
            ? "settled"
            : "no-change");
        const { error: _previousError, ...settled } = receipt;
        entries.push({
          namespace: DIMENSION_SETTLEMENT_NAMESPACE,
          key: receipt.source.resultId,
          expectedVersion: receipt.version,
          value: { ...settled, status, version: receipt.version + 1 },
          timestamp: proposal.timestamp,
        });
      }
      if (
        !(await store.compareAndSetPluginDataBatch(
          proposal.sessionId,
          pluginId,
          entries,
        ))
      )
        // Keep the stable prefix so a lost race maps to the same 409 as a
        // pre-check conflict instead of a generic commit failure.
        return pending(
          "dimension-version-conflict: Dimension version conflict; refresh and re-evaluate",
        );
      const publicChanges = changed.filter(
        ([id, record]) =>
          !base[id] ||
          !dimensionsJsonEqual(base[id]!.value, record.value) ||
          !dimensionsJsonEqual(base[id]!.definition, record.definition),
      );
      if (publicChanges.length)
        return event("dimensions.changed", {
          dimensions: dimensionSnapshotFromRecords(
            Object.fromEntries(publicChanges),
          ),
          ...(status
            ? {
                settlement: {
                  source: receipt!.source,
                  status,
                  sourceTurnId: receipt!.sourceTurnId,
                  version: receipt!.version + 1,
                },
              }
            : {}),
        });
      if (status)
        return event("dimensions.settlement.changed", {
          source: receipt!.source,
          status,
          sourceTurnId: receipt!.sourceTurnId,
          version: receipt!.version + 1,
        });
      return { committed: true };
    } catch (error) {
      if (
        error instanceof DimensionConflictError ||
        error instanceof DimensionValidationError ||
        error instanceof ZodError
      ) {
        return receipt
          ? pending(error.message)
          : commitError(
              error instanceof DimensionConflictError
                ? `dimension-version-conflict: ${error.message}`
                : error.message,
            );
      }
      // Infrastructure failures still roll back the enclosing execution;
      // only a rejected domain plan can commit a narrative with pending debt.
      throw error;
    }
  }
  return { "dimension.initialize": commit, "dimension.update": commit };
}
