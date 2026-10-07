import { useTranslation } from "react-i18next";
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

interface SessionDimensionsPanelProps {
  snapshot?: Awaited<ReturnType<typeof getSessionView>>;
  onRefresh?: () => Promise<void>;
  allowValueEditing?: boolean;
  recoveryOnly?: boolean;
}

/** Debug snapshots and the active game session have separate owners. */
export function SessionDimensionsPanel(
  props: SessionDimensionsPanelProps = {},
) {
  if (props.snapshot)
    return (
      <DimensionsView
        {...props}
        view={props.snapshot}
        sessionId={props.snapshot.session.id}
        disabled={false}
        onRefresh={props.onRefresh ?? (async () => {})}
      />
    );
  return <ActiveSessionDimensionsPanel {...props} />;
}

function ActiveSessionDimensionsPanel(props: SessionDimensionsPanelProps) {
  const { state, resumeSessionById } = useSession();
  return (
    <DimensionsView
      {...props}
      view={state.gameState}
      sessionId={state.session?.id}
      disabled={state.executing}
      onRefresh={async () => {
        if (state.session) await resumeSessionById(state.session.id);
      }}
    />
  );
}

function DimensionsView({
  view,
  sessionId,
  disabled,
  onRefresh,
  allowValueEditing = false,
  recoveryOnly = false,
}: SessionDimensionsPanelProps & {
  view:
    | ReturnType<typeof useSession>["state"]["gameState"]
    | Awaited<ReturnType<typeof getSessionView>>;
  sessionId?: string;
  disabled: boolean;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const dimensions = dimensionSnapshotSchema.parse(view.dimensions ?? {});
  const recovery = view.dimensionRecovery as DimensionRecovery | undefined;
  const provider = view.dimensionProviderPluginId;
  const settlements = (view.dimensionSettlements ??
    []) as readonly DimensionSettlementSummary[];
  async function edit(payload: DimensionEditRequest, sourceTurnId?: string) {
    if (!sessionId || typeof provider !== "string" || !recovery)
      throw new Error(t("world.dimensionError.unavailable"));
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
      await onRefresh();
      throw error;
    }
    const current = await getSessionView(sessionId);
    await onRefresh();
    if (result.status !== "ok")
      throw new Error(t("world.dimensionError.failed"));
    for (const runtime of result.runtimeResults ?? []) {
      const output = runtime.output as { code?: string } | undefined;
      if (output?.code === "dimension-version-conflict")
        throw new Error(t("world.dimensionError.conflict"));
    }
    const failed = result.runtimeResults?.find(
      (runtime) => runtime.status === "failed",
    );
    if (failed)
      throw new Error(failed.error ?? t("world.dimensionError.failed"));
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
        throw new Error(t("world.dimensionError.conflict"));
    }
    if (
      payload.resultId &&
      current?.dimensionSettlements?.some(
        (receipt) =>
          receipt.source.resultId === payload.resultId &&
          receipt.status === "pending-settlement",
      )
    )
      throw new Error(t("world.dimensionError.pending"));
  }
  return (
    <WorldDimensionsPanel
      dimensions={dimensions}
      allowValueEditing={allowValueEditing}
      recoveryOnly={recoveryOnly}
      settlements={settlements}
      disabled={disabled}
      {...(recovery && typeof provider === "string" ? { onEdit: edit } : {})}
    />
  );
}
