/**
 * Full-screen visual-novel stage (viewMode: "stage"). Composes the five stage
 * layers over kernel UI projections and owns the small amount of
 * cross-layer state the pieces can't hold themselves: which turn's text is
 * fully read (switches narrative into the unified decision panel), auto-play,
 * and the history / pending-form modals.
 *
 * Absolute-positioned layers stack inside a `relative` bounded container in
 * DOM order Backdrop → Sprites → Hud → Dialog → Choices (z-index banded on
 * the components). UI slots supply committed values and turn previews.
 */
import type { InteractionSubmitResult } from "@/stores/session-store/types.js";
import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import type {
  StageBackdropModel,
  StageCastModel,
  StageChoicesModel,
  StageDialogueModel,
  CharacterVisualModel,
} from "@covel/shared";
import { useUiSlots } from "@/stores/ui-slot-store.js";
import { pluginMessageTurnResolver } from "@/stores/session-store/plugin-message-turn.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useMediaQuery } from "@/hooks/use-media-query.js";
import { useStreamingText } from "@/stores/streaming-text-store.js";
import type { StreamMessage, ExecutionStep } from "@/stores/session-store.js";
import type {
  SessionRecord,
  WorldRecord,
  PluginSummary,
  SessionPlugin,
} from "@/services/api.js";
import { ChatMessages } from "../chat-messages.js";
import { MessageBlockRenderer } from "../chat-messages/message-blocks.js";
import { StageBackdrop } from "./StageBackdrop.js";
import { StageSprites } from "./StageSprites.js";
import { StageHud } from "./StageHud.js";
import { StageDialog } from "./StageDialog.js";
import { StagePluginPanels } from "./StagePluginPanels.js";
import { StageChoices } from "./StageChoices.js";
import { StageExecutionStatus } from "./StageExecutionStatus.js";
import {
  deriveDecisionRecapFallback,
  extractInteractionChoices,
  extractPendingFormMessages,
  filterStalePrompts,
  initialStageReadStoryKey,
  stageStoryKey,
  type PresenceRecord,
  type StageSpeaker,
} from "./stage-selectors.js";

export interface StageViewProps {
  readonly session: SessionRecord;
  readonly world: WorldRecord | null;
  readonly messages: StreamMessage[];
  readonly executing: boolean;
  /** The session is being restored: a story that arrives now is history. */
  readonly restoring?: boolean;
  readonly executionError: string | null;
  readonly executionSteps: ExecutionStep[];
  readonly plugins: PluginSummary[];
  readonly sessionPlugins: SessionPlugin[];
  readonly submittedBlockIds: ReadonlySet<string>;
  readonly submittedBlockValues: Readonly<
    Record<string, Record<string, unknown>>
  >;
  readonly onSendMessage: (text: string) => void;
  readonly onSubmitBlock: (blockId: string) => void;
  readonly onSubmitInteraction?: (
    blockId: string,
    turnId: string,
    interactionId: string,
    type: "form" | "choice" | "confirmation",
    values: Record<string, unknown>,
    submitBehavior?: { echoFilledNarrative?: boolean },
  ) => Promise<InteractionSubmitResult>;
  readonly onRetryRuntime?: (
    runtimeId: string | readonly string[] | undefined,
    sourceTurnId?: string,
  ) => void;
  readonly onBeginAdventure: () => void;
  readonly onViewModeChange: (mode: "parsed") => void;
  /** Whether studio rails are collapsed for full-screen immersion. */
  readonly immersive: boolean;
  /** Toggle immersive (full-screen) stage mode. */
  readonly onToggleImmersive: () => void;
  readonly messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

/** Latest `story` message drives the dialog; a `stream_`-prefixed id while
 *  the turn is still executing means the text is mid-stream (no dedicated
 *  streaming flag exists — see reducer.ts). */
function findLatestStory(
  messages: readonly StreamMessage[],
): StreamMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.kind === "story") return message;
  }
  return undefined;
}

export function StageView(props: StageViewProps): ReactElement {
  const {
    session,
    world,
    messages,
    executing,
    restoring = false,
    sessionPlugins,
    submittedBlockIds,
    submittedBlockValues,
    onSendMessage,
    onSubmitBlock,
    onSubmitInteraction,
    onViewModeChange,
    immersive,
    onToggleImmersive,
  } = props;
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  const slots = useUiSlots(session.id);
  const effectiveSceneCurrent = slots.find(
    (entry) => entry.slot === "stage.backdrop@1",
  )?.value as StageBackdropModel | undefined;
  const cast = slots.find((entry) => entry.slot === "stage.cast@1")?.value as
    StageCastModel | undefined;
  const dialogue = slots.find((entry) => entry.slot === "stage.dialogue@1");
  const dialogueValue = dialogue?.value as StageDialogueModel | undefined;
  const suggestions = slots.find((entry) => entry.slot === "stage.choices@1")
    ?.value as StageChoicesModel | undefined;
  const speakers: readonly StageSpeaker[] = useMemo(
    () =>
      (cast?.actors ?? []).map((actor) => ({
        id: actor.characterId,
        name: actor.displayName,
        visual: actor.visual,
        active: actor.active,
        position: actor.position,
        transition: actor.transition,
        exiting: actor.exiting,
      })),
    [cast],
  );
  const presence: Readonly<Record<string, PresenceRecord | undefined>> =
    useMemo(
      () =>
        Object.fromEntries(
          slots
            .filter(
              (entry) =>
                entry.slot === "character.visual@1" && entry.key && entry.value,
            )
            .map((entry) => [entry.key!, entry.value as CharacterVisualModel]),
        ),
      [slots],
    );

  // ── Latest story text + stream state ──────────────────────────
  // Streaming tokens no longer live in `messages[].content` — the placeholder
  // carries empty content and the live text is held in a fine-grained external
  // store. This view subscribes only to the latest story message.
  const storyMsg = findLatestStory(messages);
  const liveStoryText = useStreamingText(storyMsg?.id ?? "");
  const storyText = storyMsg ? (liveStoryText ?? storyMsg.content) : "";
  const storyTurnId = storyMsg?.turnId;
  const storyKey = stageStoryKey(storyMsg);
  const isStreaming =
    executing && (storyMsg?.id.startsWith("stream_") ?? false);
  const paragraphSpeakers =
    dialogueValue?.turnId === storyTurnId &&
    (!isStreaming || dialogue?.previewTurnId === storyTurnId)
      ? dialogueValue?.paragraphSpeakers
      : undefined;

  // ── Cross-layer state ─────────────────────────────────────────
  const [autoPlay, setAutoPlay] = useState(false);
  // A story already present when Stage mounts has been read in another view or
  // before a restore. Mark it read instead of replaying old text from scratch.
  // New story keys naturally fall back to the narrative dialog until it calls
  // `onAllRead`.
  const [readStoryKey, setReadStoryKey] = useState<string | undefined>(() =>
    initialStageReadStoryKey(storyMsg),
  );
  // Stage can also mount before a restore delivers the history. The first
  // story it then receives has been read as well, unless a turn running in
  // this view is writing it. A restore counts as executing until it has
  // checked the session's execution, so `restoring` tells the two apart.
  const [awaitingHistory, setAwaitingHistory] = useState(!storyMsg);
  if (awaitingHistory && storyMsg) {
    setAwaitingHistory(false);
    if (!executing || restoring)
      setReadStoryKey(initialStageReadStoryKey(storyMsg));
  }
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dismissedFormIds, setDismissedFormIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const interactionChoices = useMemo(
    () => extractInteractionChoices(messages, submittedBlockIds),
    [messages, submittedBlockIds],
  );
  const pendingForms = useMemo(
    () => extractPendingFormMessages(messages, submittedBlockIds),
    [messages, submittedBlockIds],
  );
  // Drop guide prompts left over from a previous turn (StageChoices merges them
  // in via mergeChoices, which doesn't itself check freshness).
  const freshPrompts = useMemo(
    () =>
      filterStalePrompts(
        suggestions,
        storyTurnId,
        pluginMessageTurnResolver(props.executionSteps, messages),
      ),
    [suggestions, storyTurnId, props.executionSteps, messages],
  );
  const stageTurnIds = useMemo(() => {
    const resolveTurn = pluginMessageTurnResolver(
      props.executionSteps,
      messages,
    );
    return [
      ...new Set(
        [
          storyTurnId,
          ...props.executionSteps.map((step) => step.turnId),
        ].filter(
          (id): id is string =>
            typeof id === "string" && resolveTurn(id) === storyTurnId,
        ),
      ),
    ];
  }, [storyTurnId, props.executionSteps, messages]);
  const activeForm = pendingForms.find((m) => !dismissedFormIds.has(m.id));
  const fallbackRecap = useMemo(
    () => deriveDecisionRecapFallback(storyText),
    [storyText],
  );
  const allRead = Boolean(storyKey && readStoryKey === storyKey);
  // Hide the previous decision, including plugin surfaces, as soon as a turn
  // starts. Keep already-read narration hidden while waiting for the new story.
  const choicesVisible = !executing && allRead;
  const dialogVisible = !allRead && storyText.trim().length > 0;

  return (
    <div
      className="relative flex-1 min-h-0 overflow-hidden"
      data-testid="stage-view"
    >
      <StageBackdrop
        sceneCurrent={effectiveSceneCurrent}
        world={world}
        sessionId={session.id}
      />
      <StageSprites
        speakers={speakers}
        presence={presence}
        sessionId={session.id}
        dimmed={choicesVisible}
        retainWhenEmpty={cast?.retainWhenEmpty ?? true}
      />
      <StageHud
        sceneCurrent={effectiveSceneCurrent}
        locale={locale}
        autoPlay={autoPlay}
        immersive={immersive}
        onOpenHistory={() => setHistoryOpen(true)}
        onToggleAutoPlay={() => setAutoPlay((v) => !v)}
        onToggleImmersive={onToggleImmersive}
        onExit={() => onViewModeChange("parsed")}
      />
      {dialogVisible && (
        <StageDialog
          turnId={storyTurnId}
          storyText={storyText}
          streamEnded={!isStreaming}
          paragraphSpeakers={paragraphSpeakers}
          autoPlay={autoPlay}
          reducedMotion={reducedMotion}
          onAllRead={() => setReadStoryKey(storyKey)}
        />
      )}
      <StageChoices
        extensions={(choices) => (
          <StagePluginPanels
            sessionId={session.id}
            activePluginIds={sessionPlugins
              .filter((plugin) => plugin.active)
              .map((plugin) => plugin.id)}
            choices={choices.map(({ id, label }) => ({ id, text: label }))}
            turnIds={stageTurnIds}
            turnId={storyTurnId}
            executing={executing}
            onSendMessage={onSendMessage}
          />
        )}
        visible={choicesVisible}
        executing={executing}
        interactionChoices={interactionChoices}
        suggestions={freshPrompts}
        fallbackRecap={fallbackRecap}
        locale={locale}
        onSubmitInteraction={onSubmitInteraction}
        onSendMessage={onSendMessage}
      />

      {/* Progress replaces the decision panel until unread narration arrives. */}
      {executing && !dialogVisible && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-32 z-30 flex justify-center px-4 md:bottom-40"
          data-testid="stage-thinking"
        >
          <div className="ui-stage-panel flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            <span>{t("stage.thinkingLabel")}</span>
          </div>
        </div>
      )}

      <StageExecutionStatus {...props} />

      {/* History drawer — the full parsed chat, needs a bounded flex column
          for its internal scroll viewport (flex-1 min-h-0). Retain execution
          data for thinking disclosures, but keep the runtime timeline and
          failed-turn banner on the stage itself. */}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent
          className="max-w-3xl p-0 gap-0"
          aria-describedby={undefined}
        >
          <DialogHeader className="px-4 pt-4 pb-2">
            <DialogTitle>{t("stage.historyTitle")}</DialogTitle>
          </DialogHeader>
          <div className="flex h-[80vh] flex-col">
            <ChatMessages
              {...props}
              viewMode="parsed"
              showExecutionTimeline={false}
              executionError={null}
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* Pending form modal — the inline dialog only takes choices/free text,
          so a form interaction surfaces here. */}
      <Dialog
        open={!!activeForm}
        onOpenChange={(open) => {
          if (!open && activeForm) {
            setDismissedFormIds((prev) => new Set(prev).add(activeForm.id));
          }
        }}
      >
        <DialogContent className="max-w-lg" aria-describedby={undefined}>
          <DialogHeader className="sr-only">
            <DialogTitle>{t("stage.formTitle")}</DialogTitle>
          </DialogHeader>
          {activeForm && (
            <MessageBlockRenderer
              msg={activeForm}
              block={activeForm.block as Record<string, unknown>}
              submitted={submittedBlockIds.has(activeForm.id)}
              submittedValues={submittedBlockValues[activeForm.id]}
              executing={executing}
              onSubmitInteraction={onSubmitInteraction}
              onSendMessage={onSendMessage}
              onSubmitBlock={onSubmitBlock}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
