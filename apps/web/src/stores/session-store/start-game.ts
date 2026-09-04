import i18n from "i18next";
import * as api from "@/services/api";
import type { DataService, SessionWorkspace } from "@/services/data-service.js";
import { setActiveSession as setActivePluginDataSession } from "@/stores/plugin-data-store.js";
import { enrichGameStateFromSnapshot } from "./game-state.js";
import { hydratePluginDataForUiSpecs } from "./plugin-data-hydration.js";
import type { SessionDispatch } from "./types.js";

interface MutableRef<T> {
  current: T;
}

interface StartGameOptions {
  ds: DataService;
  workspace: SessionWorkspace;
  dispatch: SessionDispatch;
  sessionIdRef: MutableRef<string | null>;
  world: api.WorldRecord;
  presets: readonly api.PresetSummary[];
  llmConfig: api.LlmConfigResponse | null;
  plugins?: string[];
}

function selectPresetId(
  presets: readonly api.PresetSummary[],
  llmConfig: api.LlmConfigResponse | null,
): string | undefined {
  const slotConfig = api.getSlotConfig();
  const configuredSlotIds = llmConfig?.configured
    ? Object.keys(llmConfig.slots)
    : [];
  const primarySlotId = configuredSlotIds[0];
  const primaryPresetId = primarySlotId
    ? (slotConfig[primarySlotId]?.modelRef ??
      slotConfig[primarySlotId]?.presetId ??
      `slot-${primarySlotId}`)
    : undefined;
  const defaultPresetId =
    slotConfig.default?.modelRef ?? slotConfig.default?.presetId;
  return (
    primaryPresetId ??
    defaultPresetId ??
    presets.find((preset) => preset.isDefault)?.id ??
    presets[0]?.id
  );
}

async function hydrateInitialSnapshot(
  sessionId: string,
  sessionIdRef: MutableRef<string | null>,
  dispatch: SessionDispatch,
): Promise<void> {
  const snapshot = await api.getSessionView(sessionId);
  if (sessionIdRef.current !== sessionId) return;

  dispatch({
    type: "SET_GAME_STATE",
    state: enrichGameStateFromSnapshot(snapshot),
  });
}

async function persistPrepRuntimeBindings(
  ds: DataService,
  worldId: string,
  sessionId: string,
): Promise<void> {
  const prepBindings = api.getPrepRuntimeBindings(worldId);
  if (Object.keys(prepBindings).length === 0) return;

  const overrides: Record<string, string> = {};
  for (const [runtimeId, slot] of Object.entries(prepBindings)) {
    if (typeof slot === "string" && slot.length > 0) {
      overrides[runtimeId] = slot;
    }
  }

  try {
    await ds.updateSession(sessionId, {
      runtimeModelOverrides: overrides,
    });
    api.clearPrepRuntimeBindings(worldId);
  } catch {
    // Non-fatal: keep the Prep bindings so a later retry can persist them.
  }
}

export async function startGameSession({
  ds,
  workspace,
  dispatch,
  sessionIdRef,
  world,
  presets,
  llmConfig,
  plugins,
}: StartGameOptions): Promise<void> {
  let createdSessionId: string | null = null;
  let published = false;
  dispatch({ type: "SET_EXECUTION_ERROR", error: null });
  try {
    const session = await ds.createSession(
      world.id,
      selectPresetId(presets, llmConfig),
      undefined,
      plugins,
      world.locale ?? i18n.language,
    );
    createdSessionId = session.id;

    // Local mode creates the browser record first. Establish the authoritative
    // server mirror before publishing an executable session or issuing any
    // server-backed hydration / model-binding calls. Remote mode is already
    // authoritative and implements syncToServer as a no-op.
    await workspace.hydrate(session.id);
    api.markServerAck();
    await persistPrepRuntimeBindings(ds, world.id, session.id);
    const hydratedSession = (await ds.getSession(session.id)) ?? session;

    setActivePluginDataSession(session.id);
    sessionIdRef.current = session.id;
    published = true;
    dispatch({ type: "SET_SESSION", session: hydratedSession });

    await hydrateInitialSnapshot(session.id, sessionIdRef, dispatch);

    try {
      await hydratePluginDataForUiSpecs(
        session.id,
        dispatch,
        () => sessionIdRef.current === session.id,
      );
    } catch {
      // Right-panel hydration will retry when its own ui-spec loader runs.
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (published) {
      try {
        sessionIdRef.current = null;
        setActivePluginDataSession(null);
        dispatch({ type: "RESET_SESSION" });
      } catch {
        // Recovery must not replace the bootstrap error reported to the caller.
      }
    }
    if (createdSessionId) {
      await ds.deleteSession(createdSessionId).catch(() => undefined);
    }
    dispatch({
      type: "SET_EXECUTION_ERROR",
      error: error.message,
    });
    throw error;
  }
}
