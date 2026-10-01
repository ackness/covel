import {
  dimensionSnapshotSchema,
  dimensionsJsonEqual,
  type DimensionRecovery,
  type DimensionSettlementSummary,
} from "@covel/shared";
import { getSessionView, postPluginRpc } from "@/services/api.js";
import { getSessionWorkspace } from "@/services/data-service.js";
import { useSession } from "@/stores/session-store.js";
import {
  WorldDimensionsPanel,
  type DimensionEditRequest,
} from "./world-dimensions-panel.js";

/** Session values come only from the host snapshot, never WorldRecord initial values. */
export function SessionDimensionsPanel() {
  const { state, resumeSessionById } = useSession();
  const dimensions = dimensionSnapshotSchema.parse(
    state.gameState.dimensions ?? {},
  );
  const recovery = state.gameState.dimensionRecovery as
    DimensionRecovery | undefined;
  const provider = state.gameState.dimensionProviderPluginId;
  const settlements = (state.gameState.dimensionSettlements ??
    []) as readonly DimensionSettlementSummary[];
  async function edit(payload: DimensionEditRequest, sourceTurnId?: string) {
    const sessionId = state.session?.id;
    if (!sessionId || typeof provider !== "string" || !recovery)
      throw new Error("Dimension editor unavailable");
    let result: Awaited<ReturnType<typeof postPluginRpc>>;
    try {
      result = await getSessionWorkspace().run(
        sessionId,
        `dimension-edit:${crypto.randomUUID()}`,
        () =>
          postPluginRpc(sessionId, {
            kind: "runtime",
            pluginId: provider,
            runtimeId:
              payload.resolution === "retry"
                ? recovery.trackerRuntimeId
                : recovery.editorRuntimeId,
            payload: payload.resolution === "retry" ? {} : payload,
            ...(payload.resolution === "retry" && sourceTurnId
              ? { retryFromTurnId: sourceTurnId }
              : {}),
          }),
      );
    } catch (error) {
      await resumeSessionById(sessionId);
      throw error;
    }
    const current = await getSessionView(sessionId);
    await resumeSessionById(sessionId);
    if (result.status !== "ok")
      throw new Error(`Dimension edit: ${result.status}`);
    for (const runtime of result.runtimeResults ?? []) {
      const output = runtime.output as { code?: string } | undefined;
      if (output?.code === "dimension-version-conflict")
        throw new Error(
          "dimension-version-conflict: refreshed to current values; review and submit again",
        );
    }
    const failed = result.runtimeResults?.find(
      (runtime) => runtime.status === "failed",
    );
    if (failed) throw new Error(failed.error ?? "Dimension edit failed");
    for (const update of payload.updates) {
      const entry = current?.dimensions[update.id];
      // Validate against the server's returned state, not a predicted +0/+1
      // version: a same-value update bumps nothing, and a value written by a
      // racing tracker/manual edit must surface rather than be masked. The
      // committed version must be >= the version the edit was based on, and
      // the applied value must match what we asked for.
      if (
        !entry ||
        entry.version < update.expectedVersion ||
        !dimensionsJsonEqual(entry.value, update.value)
      )
        throw new Error(
          `dimension-version-conflict: ${update.id} currentVersion=${entry?.version ?? "missing"}`,
        );
    }
    if (
      payload.resultId &&
      current?.dimensionSettlements?.some(
        (receipt) =>
          receipt.source.resultId === payload.resultId &&
          receipt.status === "pending-settlement",
      )
    )
      throw new Error(
        "Dimension settlement is still pending; review the receipt and retry or resolve explicitly",
      );
  }
  return (
    <WorldDimensionsPanel
      dimensions={dimensions}
      settlements={settlements}
      disabled={state.executing}
      {...(recovery && typeof provider === "string" ? { onEdit: edit } : {})}
    />
  );
}
