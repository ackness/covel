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

  // Legacy blockSelections path is kept only to satisfy ChatMessages' prop
  // contract (some older blocks still wire onSelect). The "confirm & send"
  // bar below is driven by pendingInteractionDrafts.
  const [blockSelections, setBlockSelections] = useState<
    Record<string, string>
  >({});

  const handleBlockSelect = useCallback((blockId: string, value: string) => {
    setBlockSelections((prev) => ({ ...prev, [blockId]: value }));
  }, []);

  const {
    state: sessionState,
    clearInteractionDrafts,
    removeInteractionDraft,
    submitBlock,
    resumeSuspension,
    cancelSuspension,
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
  const composerDisabled = executing || composerBlocked;

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
    setBlockSelections({});
  }, [pendingDrafts, clearInteractionDrafts, onSendMessage, submitBlock]);

  const handleSubmit = useCallback(() => {
    const val = inputValue.trim();
    if (!val || composerDisabled) return;
    onSendMessage(val);
    setInputValue("");
  }, [inputValue, composerDisabled, onSendMessage]);

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
    blockSelections,
    handleBlockSelect,
    pendingDrafts,
    suspensions,
    composerBlocked,
    composerDisabled,
    handleConfirmDrafts,
    handleSubmit,
    handleKeyDown,
    removeInteractionDraft,
    resumeSuspension,
    cancelSuspension,
  };
}
