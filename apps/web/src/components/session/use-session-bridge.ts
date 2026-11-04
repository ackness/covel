import { useMemo, useRef } from "react";
import { useSession } from "@/stores/session-store.js";
import { useUiSlots } from "@/stores/ui-slot-store.js";
import { useSetting } from "@/settings/use-settings.js";
import { readLiveOutputPreference } from "@/stores/session-store/output-drafts.js";
import {
  buildSessionProjection,
  createSessionMessageOrdinals,
  sessionProjectionDrafts,
  sessionProjectionSchema,
} from "./session-bridge.js";

const EMPTY_CHARACTERS: readonly unknown[] = [];

function warnOnce(warned: { current: boolean }): void {
  if (warned.current) return;
  warned.current = true;
  console.warn(
    "[session-bridge] Invalid session projection; withholding state",
  );
}
export function useSessionBridge(
  sessionId: string,
  interactionHandle?: (
    message: import("@/stores/session-store.js").StreamMessage,
  ) => string | undefined,
) {
  const { state } = useSession();
  const { session, messages, executing, submittedBlockIds, outputDrafts } =
    state;
  const [liveOutputSetting] = useSetting<string>("ui.liveOutput");
  const liveOutput = readLiveOutputPreference(liveOutputSetting);
  const characters = Array.isArray(state.gameState.characters)
    ? state.gameState.characters
    : EMPTY_CHARACTERS;
  const slots = useUiSlots(sessionId);
  const warned = useRef(false);
  const assignOrdinals = useMemo(
    () => createSessionMessageOrdinals(),
    [sessionId],
  );
  const messageSeqs = useMemo(
    () => assignOrdinals(messages),
    [assignOrdinals, messages],
  );
  // Drafts change many times a second while a story is written; the rest of
  // the projection is rebuilt only when its own inputs change.
  const base = useMemo(() => {
    if (!session || session.id !== sessionId) return undefined;
    const result = sessionProjectionSchema.safeParse(
      buildSessionProjection({
        session,
        actionKinds: state.sessionActionKinds,
        locale: session.locale,
        interactionHandle,
        executing,
        messages,
        messageSeqs,
        submittedBlockIds,
        characters,
        slots,
      }),
    );
    if (result.success) return result.data;
    warnOnce(warned);
    return undefined;
  }, [
    session,
    state.sessionActionKinds,
    interactionHandle,
    sessionId,
    executing,
    messages,
    messageSeqs,
    submittedBlockIds,
    characters,
    slots,
  ]);
  const projection = useMemo(() => {
    if (!base) return undefined;
    const drafts = sessionProjectionSchema.shape.drafts.safeParse(
      sessionProjectionDrafts(outputDrafts, liveOutput),
    );
    if (drafts.success) return { ...base, drafts: drafts.data };
    warnOnce(warned);
    return undefined;
  }, [base, outputDrafts, liveOutput]);
  return { projection };
}
