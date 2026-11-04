import { StoryOperationFailureNotice } from "../chat-messages/story-operation-failure-notice.js";
import { projectStoryOperationFailures, stageCastSchema } from "@covel/shared";
/**
 * Full-screen visual-novel stage (viewMode: "stage"). Composes the five stage
 * layers over kernel UI projections and owns the small amount of
 * cross-layer state the pieces can't hold themselves: reader auto-play,
 * and the history / pending-form modals.
 *
 * Absolute-positioned layers stack inside a `relative` bounded container in
 * DOM order Backdrop → Sprites → Hud → Dialog → Choices (z-index banded on
 * the components). UI slots supply committed values and turn previews.
 */
import type { InteractionSubmitResult } from "@/stores/session-store/types.js";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from "react";
import { useSetting } from "@/settings/use-settings.js";
import { SessionStateContext } from "@/stores/session-store/context.js";
import {
  draftStoryMessage,
  readLiveOutputPreference,
  visibleDraftUnits,
} from "@/stores/session-store/output-drafts.js";
import { useTranslation } from "react-i18next";
import type {
  StageBackdropModel,
  StageChoicesModel,
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
import { StageReader } from "./StageReader.js";
import type { RightPanelState } from "../right-panel-state.js";
import { StagePluginPanels } from "./StagePluginPanels.js";
import { StageChoices } from "./StageChoices.js";
import type { ComposerModes } from "../game-view/use-composer-modes.js";
import { StageExecutionStatus } from "./StageExecutionStatus.js";
import {
  extractInteractionChoices,
  extractPendingFormMessages,
  filterStalePrompts,
  type PresenceRecord,
  type StageSpeaker,
} from "./stage-selectors.js";

export interface StageViewProps {
  readonly composerDraft?: { value: string; onChange: (value: string) => void };
  /** The composer's modes and character switcher, shared with the free input. */
  readonly composerModes?: ComposerModes;
  readonly panelState: Pick<
    RightPanelState,
    "rightSpecs" | "specsStatus" | "retrySpecs"
  >;
  readonly session: SessionRecord;
  readonly world: WorldRecord | null;
  readonly messages: StreamMessage[];
  readonly executing: boolean;
  readonly advancing?: boolean;
  readonly executionError: string | null;
  readonly executionSteps: ExecutionStep[];
  readonly recoveryTurnId?: string;
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

/** The latest committed story drives the dialog. */
function findLatestStory(
  messages: readonly StreamMessage[],
): StreamMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.kind === "story") return message;
  }
  return undefined;
}

/**
 * One story per turn and runtime, whether still a draft or committed, so the
 * reader keeps its page when the draft becomes the story.
 */
function readerKey(
  message: Pick<StreamMessage, "id" | "turnId" | "runtimeId">,
): string {
  return message.turnId && message.runtimeId
    ? `${message.turnId}:${message.runtimeId}`
    : message.id;
}

export function StageView(props: StageViewProps): ReactElement {
  const {
    session,
    world,
    messages,
    executing,
    advancing = false,
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
  const castValue = slots.find((entry) => entry.slot === "stage.cast@1")?.value;
  const cast = useMemo(() => {
    const parsed = stageCastSchema.safeParse(castValue);
    return parsed.success ? parsed.data : undefined;
  }, [castValue]);
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

  const storyMsg = findLatestStory(messages);
  const storyTurnId = storyMsg?.turnId;

  // A story still being written, as far as this player wants to see it.
  const outputDrafts = useContext(SessionStateContext)?.outputDrafts;
  const [liveOutput] = useSetting<string>("ui.liveOutput");
  const preference = readLiveOutputPreference(liveOutput);
  // The latest turn's story; within a turn, the runtime that started first.
  const draft = useMemo(() => {
    if (preference === "committed") return undefined;
    const shown = (outputDrafts ?? []).flatMap((entry) => {
      const units = visibleDraftUnits(entry, preference);
      return units || entry.revising ? [{ entry, units: units ?? [] }] : [];
    });
    const latestTurn = shown.at(-1)?.entry.turnId;
    const found = shown.find(({ entry }) => entry.turnId === latestTurn);
    return found
      ? {
          entry: found.entry,
          message: draftStoryMessage(found.entry, found.units),
        }
      : undefined;
  }, [outputDrafts, preference]);

  // ── Cross-layer state ─────────────────────────────────────────
  const [autoPlay, setAutoPlay] = useState(false);
  // A story already on screen when the stage opens counts as read; each story
  // after that opens line by line at the top of the decision panel, from its
  // first draft on.
  const target = draft?.message ?? storyMsg;
  const targetKey = target ? readerKey(target) : undefined;
  const [readKey, setReadKey] = useState(() =>
    storyMsg ? readerKey(storyMsg) : undefined,
  );
  const draftKey = draft ? readerKey(draft.message) : undefined;
  // A story read as a draft stays open while its turn finishes.
  const [liveKey, setLiveKey] = useState<string>();
  useEffect(() => {
    if (draftKey) setLiveKey(draftKey);
  }, [draftKey]);
  const [page, setPage] = useState<{ key?: string; index: number }>({
    index: 0,
  });
  const revising = draft?.entry.revising ?? false;
  // A revision voids what was read; it starts again at the first line.
  useEffect(() => {
    if (revising) setPage((current) => ({ ...current, index: 0 }));
  }, [revising]);
  const [speakingId, setSpeakingId] = useState<string | undefined>();
  const finishReading = useCallback(() => setReadKey(targetKey), [targetKey]);
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
  // Only current turn-scoped suggestions reach the decision panel.
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
  // Only execution controls action availability; reading never gates input.
  const reading =
    !!target &&
    targetKey !== readKey &&
    (!!draft || targetKey === liveKey || (!executing && !advancing));
  const choicesVisible = advancing || !executing;
  // Done reading line by line, the player sees the whole story: the draft
  // while it is written, otherwise the latest committed one.
  const shownStory = draft?.message ?? storyMsg;
  const reader =
    reading && target ? (
      <StageReader
        key={targetKey}
        sessionId={session.id}
        message={target}
        autoPlay={autoPlay}
        reducedMotion={reducedMotion}
        onSpeakerChange={setSpeakingId}
        onFinish={finishReading}
        index={page.key === targetKey ? page.index : 0}
        onIndexChange={(index) => setPage({ key: targetKey, index })}
        writing={!!draft && !draft.entry.accepted}
        revising={revising}
      />
    ) : undefined;

  return (
    <div
      className="relative flex flex-col flex-1 min-h-0 overflow-hidden"
      data-testid="stage-view"
    >
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <StageBackdrop
          sceneCurrent={effectiveSceneCurrent}
          world={world}
          sessionId={session.id}
        />
        {cast && (
          <StageSprites
            key={session.id}
            speakers={speakers}
            presence={presence}
            sessionId={session.id}
            dimmed={choicesVisible && !reading}
            retainWhenEmpty={cast.retainWhenEmpty}
            exitTransition={cast.exitTransition}
            speakingId={reading ? speakingId : undefined}
          />
        )}
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
        {/* While the turn runs, a story being read gets the panel alone. */}
        {reader && !choicesVisible && (
          <div
            className="pointer-events-none absolute inset-x-0 top-[40%] bottom-0 z-40 flex items-end justify-center px-3 pb-3 md:top-[35%] md:px-8 md:pb-8"
            data-testid="stage-draft-panel"
          >
            <section className="ui-stage-panel pointer-events-auto flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-(--radius-card)">
              <div className="min-h-0 overflow-y-auto overscroll-contain">
                {reader}
              </div>
            </section>
          </div>
        )}
        {executing && shownStory && !reading && (
          <StageDialog
            key={shownStory.id}
            sessionId={session.id}
            message={shownStory}
            autoPlay={autoPlay}
            reducedMotion={reducedMotion}
          />
        )}
        <StageChoices
          storyReview={
            reader ? (
              reader
            ) : shownStory ? (
              <StageDialog
                key={shownStory.id}
                inline
                sessionId={session.id}
                message={shownStory}
                autoPlay={autoPlay}
                reducedMotion={reducedMotion}
              />
            ) : undefined
          }
          composerDraft={props.composerDraft}
          composerModes={props.composerModes}
          extensions={(choices, onDraftMessage) => (
            <StagePluginPanels
              panelState={props.panelState}
              activePluginIds={sessionPlugins
                .filter((plugin) => plugin.active)
                .map((plugin) => plugin.id)}
              choices={choices.map(({ id, label }) => ({ id, text: label }))}
              turnIds={stageTurnIds}
              turnId={storyTurnId}
              executing={executing}
              onDraftMessage={onDraftMessage}
            />
          )}
          visible={choicesVisible}
          advancing={advancing}
          executing={executing}
          interactionChoices={interactionChoices}
          suggestions={freshPrompts}
          locale={locale}
          onSubmitInteraction={onSubmitInteraction}
          onSendMessage={onSendMessage}
        />

        <StageExecutionStatus {...props} />
      </div>

      {storyMsg &&
        projectStoryOperationFailures(storyMsg).operationFailures && (
          <div className="shrink-0 border-t border-border bg-background px-4 py-2">
            <StoryOperationFailureNotice message={storyMsg} />
          </div>
        )}

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
