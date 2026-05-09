import i18n from "i18next";
import * as api from "@/services/api";
import type { DataService } from "@/services/data-service.js";
import { setActiveSession as setActivePluginDataSession } from "@/stores/plugin-data-store.js";
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
    ? (slotConfig[primarySlotId]?.presetId ?? `slot-${primarySlotId}`)
    : undefined;
  const defaultPresetId = slotConfig.default?.presetId;
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

    const enrichedState: Record<string, unknown> = {
      ...snapshot.gameState,
      characters: snapshot.characters,
    };
    if (snapshot.characterSchema) {
      enrichedState.characterSchema = snapshot.characterSchema;
    }
    dispatch({ type: "SET_GAME_STATE", state: enrichedState });
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
  } catch {
    // Non-fatal: overrides fall back to manifest defaults when missing.
  }

  api.clearPrepRuntimeBindings(worldId);
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
    dispatch({ type: "SET_SESSION", session });
    setActivePluginDataSession(session.id);

    await hydrateInitialSnapshot(session.id, sessionIdRef, dispatch);

    try {
      await hydratePluginDataForUiSpecs(session.id, dispatch);
    } catch {
      // Right-panel hydration will retry when its own ui-spec loader runs.
    }

    await persistPrepRuntimeBindings(world.id, session.id);
    await ds.syncToServer(session.id);
    api.markServerAck();
  } catch (err) {
    dispatch({
      type: "SET_EXECUTION_ERROR",
      error: (err as Error).message,
    });
  }
}
