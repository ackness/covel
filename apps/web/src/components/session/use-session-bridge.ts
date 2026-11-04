import { useMemo, useRef } from "react";
import { useSession } from "@/stores/session-store.js";
import { useUiSlots } from "@/stores/ui-slot-store.js";
import { useSetting } from "@/settings/use-settings.js";
import { readLiveOutputPreference } from "@/stores/session-store/output-drafts.js";
import {
  buildSessionProjection,
  createSessionMessageOrdinals,
  sessionProjectionSchema,
} from "./session-bridge.js";

const EMPTY_CHARACTERS: readonly unknown[] = [];
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
  const projection = useMemo(() => {
    if (!session || session.id !== sessionId) return undefined;
    const result = sessionProjectionSchema.safeParse(
      buildSessionProjection({
        session,
        actionKinds: state.sessionActionKinds,
        locale: session.locale,
        interactionHandle,
        executing,
        messages,
        drafts: outputDrafts,
        liveOutput,
        messageSeqs,
        submittedBlockIds,
        characters,
        slots,
      }),
    );
    if (result.success) return result.data;
    if (!warned.current) {
      warned.current = true;
      console.warn(
        "[session-bridge] Invalid session projection; withholding state",
      );
    }
    return undefined;
  }, [
    session,
    state.sessionActionKinds,
    interactionHandle,
    sessionId,
    executing,
    messages,
    outputDrafts,
    liveOutput,
    messageSeqs,
    submittedBlockIds,
    characters,
    slots,
  ]);
  return { projection };
}
