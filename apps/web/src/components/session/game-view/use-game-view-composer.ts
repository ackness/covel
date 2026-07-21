import { useCallback, useMemo, useState, type KeyboardEvent } from "react";
import { useSession, type StreamMessage } from "@/stores/session-store.js";
import { isPendingInteractionMessage } from "./interaction-blocks.js";

interface UseGameViewComposerArgs {
  messages: StreamMessage[];
  submittedBlockIds: ReadonlySet<string>;
  executing: boolean;
  onSendMessage: (content: string) => void;
}

export function useGameViewComposer({
  messages,
  submittedBlockIds,
  executing,
  onSendMessage,
}: UseGameViewComposerArgs) {
  const [inputValue, setInputValue] = useState("");

  const {
    state: sessionState,
    clearInteractionDrafts,
    removeInteractionDraft,
    submitBlock,
    resumeSuspension,
    cancelSuspension,
    steerMessage,
    abortActiveTurn,
  } = useSession();

  const pendingDrafts = sessionState.pendingInteractionDrafts;
  const suspensions = sessionState.suspensions;
  const hasActiveInteractionBlock = useMemo(
    () =>
      messages.some((msg) =>
        isPendingInteractionMessage(msg, messages, submittedBlockIds),
      ),
    [messages, submittedBlockIds],
  );
  const composerBlocked = pendingDrafts.length > 0 || hasActiveInteractionBlock;
  // While a turn is executing the composer stays usable — submitting
  // steers the in-flight turn instead of starting a new one.
  const composerDisabled = composerBlocked;

  const handleConfirmDrafts = useCallback(() => {
    if (pendingDrafts.length === 0) return;
    const combined = pendingDrafts
      .map((d) => String(d.values?.text ?? d.label ?? "").trim())
      .filter(Boolean)
      .join("\n");
    if (!combined) {
      clearInteractionDrafts();
      return;
    }
    // Stamp each source block with the player's selection so the disabled
    // re-render can show what was chosen. Generic across plugin types: any
    // draft that names a sourceBlockId participates without per-plugin code.
    const bySource = new Map<string, typeof pendingDrafts>();
    for (const draft of pendingDrafts) {
      if (!draft.sourceBlockId) continue;
      const list = bySource.get(draft.sourceBlockId) ?? [];
      list.push(draft);
      bySource.set(draft.sourceBlockId, list);
    }
    for (const [blockId, drafts] of bySource) {
      const items = drafts.map((d) => ({
        type: d.type,
        label: d.label,
        values: d.values,
        interactionId: d.interactionId,
        selectionGroup: d.selectionGroup,
      }));
      const labelSummary = drafts
        .map((d) => d.label)
        .filter(Boolean)
        .join(" / ");
      submitBlock(blockId, { _kind: "selection", _label: labelSummary, items });
    }
    onSendMessage(combined);
    clearInteractionDrafts();
  }, [pendingDrafts, clearInteractionDrafts, onSendMessage, submitBlock]);

  const handleSubmit = useCallback(() => {
    const val = inputValue.trim();
    if (!val || composerDisabled) return;
    if (executing) {
      // Steer the in-flight turn; on failure (e.g. the turn ended first — 409)
      // restore the steered text to the composer so the player can re-send it.
      // Merge with anything typed during the round-trip instead of dropping it:
      // steered text first, newer draft after.
      setInputValue("");
      void steerMessage(val).then((ok) => {
        if (!ok)
          setInputValue((current) => (current ? `${val}\n${current}` : val));
      });
      return;
    }
    onSendMessage(val);
    setInputValue("");
  }, [inputValue, composerDisabled, executing, steerMessage, onSendMessage]);

  const handleAbort = useCallback(() => {
    void abortActiveTurn();
  }, [abortActiveTurn]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  return {
    inputValue,
    setInputValue,
    pendingDrafts,
    suspensions,
    composerBlocked,
    composerDisabled,
    handleConfirmDrafts,
    handleSubmit,
    handleAbort,
    handleKeyDown,
    removeInteractionDraft,
    resumeSuspension,
    cancelSuspension,
  };
}
