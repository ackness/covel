import i18n from "i18next";
import * as api from "@/services/api";
import type { DataService } from "@/services/data-service.js";
import { setActiveSession as setActivePluginDataSession } from "@/stores/plugin-data-store.js";
import { enrichGameStateFromSnapshot } from "./game-state.js";
import { hydratePluginDataForUiSpecs } from "./plugin-data-hydration.js";
import type { SessionDispatch } from "./types.js";

interface MutableRef<T> {
  current: T;
}

interface StartGameOptions {
  ds: DataService;
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
  try {
    const snapshot = await api.getSessionSnapshot(sessionId);
    const activeSessionId = sessionIdRef.current ?? sessionId;
    if (activeSessionId !== sessionId) return;

    dispatch({
      type: "SET_GAME_STATE",
      state: enrichGameStateFromSnapshot(snapshot),
    });
  } catch {
    // Snapshot hydration is best-effort; reconnect and SSE keep state fresh.
  }
}

async function persistPrepRuntimeBindings(
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
    await api.updateSession(sessionId, {
      runtimeModelOverrides: overrides,
    });
    api.clearPrepRuntimeBindings(worldId);
  } catch {
    // Non-fatal: keep the Prep bindings so a later retry can persist them.
  }
}

export async function startGameSession({
  ds,
  dispatch,
  sessionIdRef,
  world,
  presets,
  llmConfig,
  plugins,
}: StartGameOptions): Promise<void> {
  try {
    const session = await ds.createSession(
      world.id,
      selectPresetId(presets, llmConfig),
      undefined,
      plugins,
      i18n.language,
    );

    // Local mode creates the browser record first. Establish the authoritative
    // server mirror before publishing an executable session or issuing any
    // server-backed hydration / model-binding calls. Remote mode is already
    // authoritative and implements syncToServer as a no-op.
    await ds.syncToServer(session.id);
    api.markServerAck();
    await persistPrepRuntimeBindings(world.id, session.id);

    setActivePluginDataSession(session.id);
    dispatch({ type: "SET_SESSION", session });

    await hydrateInitialSnapshot(session.id, sessionIdRef, dispatch);

    try {
      await hydratePluginDataForUiSpecs(session.id, dispatch);
    } catch {
      // Right-panel hydration will retry when its own ui-spec loader runs.
    }
  } catch (err) {
    dispatch({
      type: "SET_EXECUTION_ERROR",
      error: (err as Error).message,
    });
  }
}
