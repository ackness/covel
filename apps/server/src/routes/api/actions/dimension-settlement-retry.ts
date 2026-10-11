import type { Context } from "hono";
import {
  createWorldModelView,
  pendingDimensionSettlements,
  snapshotUserSettings,
} from "@covel/runtime";
import {
  getPluginTrustInfo,
  pluginRuntimeManifests,
} from "@covel/plugin-loader";
import {
  sessionWorldContextV1,
  type RuntimeResult,
  type TurnInput,
} from "@covel/shared";
import type { SessionRecord } from "@covel/store";
import { loadSessionPluginUserSettings } from "../plugin-user-settings.js";
import { resolveMediaImageFlow } from "../media-image-flow.js";
import { withSettledSessionLock } from "../plugin-rpc/settled-request.js";
import { createPluginRpcRuntimeTurnRunner } from "../plugin-rpc/runtime-turn.js";
import { sessionApprovalScope } from "../session/session-guard.js";
import { buildTurnExecutorDeps } from "../turn-execution-deps.js";

/**
 * Settle what an earlier turn left unsettled, before the next turn starts.
 *
 * A narrative whose dimension settlement failed (the tracker timed out, its
 * update was refused) keeps a pending receipt, and the executor refuses to
 * narrate again until it is resolved. Most such failures are transient, so
 * the host first runs the same recovery the pending-settlement notice offers:
 * the provider's tracker for the source turn, seeded with that turn's
 * recorded results. The turn then starts as usual and is refused only when
 * the receipt is still pending.
 *
 * Never throws: a failed retry leaves the receipt as it was, and the
 * executor's barrier tells the player what to do.
 */
export async function retryPendingDimensionSettlements(
  c: Context,
  args: {
    readonly session: SessionRecord;
    /** The player's settings from the request, before world defaults. */
    readonly playerSettings: TurnInput["userSettings"];
  },
): Promise<void> {
  const { session } = args;
  const sessionId = session.id;
  if (session.status !== "active" || session.phase !== "playing") return;
  const store = c.get("store");
  const pluginRegistry = c.get("pluginRegistry");
  try {
    const activeRuntimes = await withSettledSessionLock(
      c,
      sessionId,
      async () => {
        const live = await store.getSession(sessionId);
        pluginRegistry.syncSessionActivations(
          sessionId,
          live?.activePlugins ?? [],
        );
        return pluginRegistry.getActiveRuntimes(sessionId);
      },
    );
    const pending = await pendingDimensionSettlements({
      store,
      sessionId,
      runtimes: activeRuntimes,
    });
    if (!pending || pending.receipts.length === 0) return;
    const { providerPluginId } = pending;
    // A manual run of a community runtime needs the player's grant for it;
    // the notice asks for one, an automatic run must not go around it.
    if (
      getPluginTrustInfo(
        providerPluginId,
        pluginRegistry.get(providerPluginId)?.source,
      ).source === "community"
    )
      return;
    const extensionHost = c.get("pluginExtensions");
    if (!extensionHost) return;
    const context = await extensionHost
      .createExecution({
        sessionId,
        locale: session.locale,
        signal: c.req.raw.signal,
        runtimeIdentities: [...pluginRegistry.getAll()].flatMap(
          ([pluginId, entry]) =>
            session.activePlugins.includes(pluginId)
              ? pluginRuntimeManifests(entry).map((parsed) => parsed.manifest)
              : [],
        ),
        world: await createWorldModelView(store, sessionId),
        readPluginData: (pluginId, namespace) =>
          store.listPluginData(sessionId, pluginId, namespace),
      })
      .run(sessionWorldContextV1, {});
    const trackerRuntimeId = context?.dimensionRecovery?.trackerRuntimeId;
    if (
      !trackerRuntimeId ||
      context.dimensionProviderPluginId !== providerPluginId
    )
      return;

    const eventBus = c.get("eventBus");
    const sessionLock = c.get("sessionLock");
    const hookPipeline = c.get("hookPipeline");
    const runner = createPluginRpcRuntimeTurnRunner({
      memorySystem: c.get("memorySystem"),
      resolveImageFlowRuntimeIds: async () =>
        (
          await resolveMediaImageFlow(
            store,
            c.get("pluginExtensions"),
            sessionId,
          )
        )?.assetRuntimeIds,
      withSettledLock: (fn, waitBudget) =>
        withSettledSessionLock(c, sessionId, fn, waitBudget),
      withSnapshot: (fn, beforeCapture) =>
        c.get("withPluginSnapshot")?.(sessionId, fn, beforeCapture) ??
        sessionLock.withLock(sessionId, async () => beforeCapture?.()).then(fn),
      pluginRegistry,
      store,
      eventBus,
      sessionLock,
      sessionId,
      session,
      activeRuntimes,
      approvalScopes: new Map(
        activeRuntimes.map((runtime) => [
          runtime.pluginId,
          sessionApprovalScope(session, runtime.pluginId),
        ]),
      ),
      deps: buildTurnExecutorDeps(c),
      ...(hookPipeline ? { hookPipeline } : {}),
    });

    const userSettings = await loadSessionPluginUserSettings(
      store,
      session,
      args.playerSettings,
    );
    for (const receipt of pending.receipts) {
      const [source] = await store.queryTurnResults(sessionId, {
        turnId: receipt.sourceTurnId,
        limit: 1,
      });
      // A source that never committed has no results to settle against.
      if (source?.commitStatus !== "committed") continue;
      const summary = await runner.runManualTurn({
        turnId: crypto.randomUUID(),
        runtimeId: trackerRuntimeId,
        retrySeedResults: (Array.isArray(source.runtimeResults)
          ? source.runtimeResults
          : []) as RuntimeResult[],
        sourceTurnId: receipt.sourceTurnId,
        ...(userSettings
          ? { userSettings: snapshotUserSettings(userSettings) }
          : {}),
      });
      const failed = summary.runtimeResults.find(
        (result) => result.status === "failed",
      );
      console.warn(
        `[dimension-settlement] retried turn ${receipt.source.turnNumber} of session ${sessionId} before the next turn: ` +
          (failed
            ? `failed (${failed.error ?? "runtime failed"})`
            : summary.commit.committed
              ? "done"
              : "not committed"),
      );
    }
  } catch (error) {
    console.warn(
      `[dimension-settlement] automatic retry in session ${sessionId} failed: ` +
        (error instanceof Error
          ? (error.stack ?? error.message)
          : String(error)),
    );
  }
}
