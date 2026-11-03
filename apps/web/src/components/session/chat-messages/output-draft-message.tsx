import type { TFunction } from "i18next";
import { memo } from "react";
import {
  draftStoryMessage,
  visibleDraftUnits,
  type LiveOutputPreference,
  type OutputDraft,
} from "@/stores/session-store/output-drafts.js";
import { ChatMessageRenderer } from "./chat-message-renderer.js";

const noop = () => {};

/**
 * A story still being written, rendered exactly like the story it becomes.
 * A void draft keeps its place with a note that the model is revising.
 */
export const OutputDraftMessage = memo(function OutputDraftMessage({
  draft,
  preference,
  sessionId,
  viewMode,
  t,
}: {
  readonly draft: OutputDraft;
  readonly preference: LiveOutputPreference;
  readonly sessionId: string;
  readonly viewMode: "parsed" | "detailed" | "raw";
  readonly t: TFunction;
}) {
  if (preference === "committed") return null;
  const units = visibleDraftUnits(draft, preference);
  if (!units && !draft.revising) return null;
  const status = draft.revising
    ? t("session.draftRevising")
    : draft.accepted
      ? undefined
      : t("session.draftWriting");
  return (
    <div
      data-testid="output-draft"
      data-draft-state={
        draft.revising ? "revising" : draft.accepted ? "accepted" : "writing"
      }
      aria-busy={!draft.accepted}
      className="flex flex-col gap-1"
    >
      {units && (
        <ChatMessageRenderer
          msg={draftStoryMessage(draft, units)}
          viewMode={viewMode}
          isImageGenActive={false}
          sessionId={sessionId}
          executing
          generatingImage={false}
          onGenerateImage={noop}
          t={t}
        />
      )}
      {status && (
        <p
          role="status"
          className="ui-eyebrow animate-pulse text-xs text-muted-foreground"
        >
          {status}
        </p>
      )}
    </div>
  );
});
