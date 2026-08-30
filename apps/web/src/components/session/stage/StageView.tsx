/**
 * Full-screen visual-novel stage (viewMode: "stage"). Composes the five stage
 * layers over a shared plugin-data feed and owns the small amount of
 * cross-layer state the pieces can't hold themselves: which turn's text is
 * fully read (switches narrative into the unified decision panel), auto-play,
 * and the history / pending-form modals.
 *
 * Absolute-positioned layers stack inside a `relative` bounded container in
 * DOM order Backdrop → Sprites → Hud → Dialog → Choices (z-index banded on
 * the components). Data all arrives through `usePluginNamespace`, so the
 * component stays thin — the real logic lives in `stage-selectors`.
 */
import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { useMediaQuery } from "@/hooks/use-media-query.js";
import { usePluginNamespace } from "@/stores/plugin-data-store.js";
import { useDomainEventPreview } from "@/stores/domain-event-preview-store.js";
import { useStreamingText } from "@/stores/streaming-text-store.js";
import type { StreamMessage, ExecutionStep } from "@/stores/session-store.js";
import type {
  SessionRecord,
  WorldRecord,
  PackageSummary,
  SessionPluginInfo,
} from "@/services/api.js";
import { ChatMessages } from "../chat-messages.js";
import { MessageBlockRenderer } from "../chat-messages/message-blocks.js";
import { StageBackdrop } from "./StageBackdrop.js";
import { StageSprites } from "./StageSprites.js";
import { StageHud } from "./StageHud.js";
import { StageDialog } from "./StageDialog.js";
import { StageChoices } from "./StageChoices.js";
import {
  applySceneSetPreview,
  applyStageDirectionPreview,
  deriveDecisionRecapFallback,
  extractInteractionChoices,
  extractPendingFormMessages,
  filterStalePrompts,
  pluginIdForCapability,
  resolveStageSpeakers,
  STAGE_CAPABILITIES,
  type PresenceRecord,
  type StageCurrentRecord,
  type StageDirectionRecord,
  type StageSceneRegistry,
  type StageSpeaker,
} from "./stage-selectors.js";

export interface StageViewProps {
  readonly session: SessionRecord;
  readonly world: WorldRecord | null;
  readonly messages: StreamMessage[];
  readonly executing: boolean;
  readonly executionError: string | null;
  readonly executionSteps: ExecutionStep[];
  readonly packages: PackageSummary[];
  readonly sessionPlugins: SessionPluginInfo[];
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
  ) => Promise<void>;
  readonly onRetryRuntime?: (
    runtimeId: string | undefined,
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
    if (messages[i].kind === "story") return messages[i];
  }
  return undefined;
}

export function StageView(props: StageViewProps): ReactElement {
  const {
    session,
    world,
    messages,
    executing,
    executionError,
    sessionPlugins,
    submittedBlockIds,
    submittedBlockValues,
    onSendMessage,
    onSubmitBlock,
    onSubmitInteraction,
    onRetryRuntime,
    onViewModeChange,
    immersive,
    onToggleImmersive,
  } = props;
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  // ── Plugin-data feeds ─────────────────────────────────────────
  // Resolve the ACTIVE plugin id for each stage capability from the session's
  // plugin list (framework↔plugin isolation rule — no hardcoded plugin ids in
  // framework code). `pluginIdForCapability` returns undefined when no active
  // plugin provides the capability; `?? ""` keeps the hook call unconditional
  // and resolves to an empty namespace, so the layer renders empty/disabled.
  // Namespaces below ("stage", "active-cast", …) are intra-plugin data keys
  // defined by the resolved plugin, not plugin ids.
  const sceneStageId =
    pluginIdForCapability(sessionPlugins, STAGE_CAPABILITIES.scene) ?? "";
  const sceneCastId =
    pluginIdForCapability(sessionPlugins, STAGE_CAPABILITIES.cast) ?? "";
  const scenePromptsId =
    pluginIdForCapability(sessionPlugins, STAGE_CAPABILITIES.prompts) ?? "";
  const presenceId =
    pluginIdForCapability(sessionPlugins, STAGE_CAPABILITIES.presence) ?? "";
  const stageDirectionId =
    pluginIdForCapability(sessionPlugins, STAGE_CAPABILITIES.direction) ?? "";

  const sceneCurrent = usePluginNamespace(sceneStageId, "stage")["current"] as
    StageCurrentRecord | undefined;
  const sceneRegistry = usePluginNamespace(sceneStageId, "scenes")[
    "scene-registry"
  ] as StageSceneRegistry | undefined;
  const activeCast = usePluginNamespace(sceneCastId, "active-cast")[
    "current"
  ] as { speakers?: readonly StageSpeaker[] } | undefined;
  const directionCurrent = usePluginNamespace(stageDirectionId, "direction")[
    "current"
  ] as StageDirectionRecord | undefined;
  const promptsNamespace = usePluginNamespace(scenePromptsId, "message");
  // Mirror portrait-gallery-panel: the presence namespace is consumed as a
  // characterId-keyed record of `{ sprite, avatar, ... }`.
  const presence = usePluginNamespace(presenceId, "presence") as Readonly<
    Record<string, PresenceRecord | undefined>
  >;
  const directionPreview = useDomainEventPreview(session.id, "stage.direction");
  const scenePreview = useDomainEventPreview(session.id, "scene.set");
  const effectiveSceneCurrent = useMemo(() => {
    if (!scenePreview || sceneCurrent?.turnId === scenePreview.turnId) {
      return sceneCurrent;
    }
    return applySceneSetPreview(
      sceneCurrent,
      sceneRegistry,
      scenePreview.data,
      scenePreview.turnId,
    );
  }, [sceneCurrent, sceneRegistry, scenePreview]);
  const speakers = useMemo(() => {
    const committed = resolveStageSpeakers(
      directionCurrent,
      activeCast?.speakers ?? [],
    );
    if (
      !directionPreview ||
      directionCurrent?.turnId === directionPreview.turnId
    ) {
      return committed;
    }
    return applyStageDirectionPreview(
      committed,
      presence,
      directionPreview.data.cues,
    );
  }, [directionCurrent, activeCast, directionPreview, presence]);

  // ── Latest story text + stream state ──────────────────────────
  // Streaming tokens no longer live in `messages[].content` — the placeholder
  // carries empty content and the live text is held in a fine-grained external
  // store. This view subscribes only to the latest story message.
  const storyMsg = findLatestStory(messages);
  const liveStoryText = useStreamingText(storyMsg?.id ?? "");
  const storyText = storyMsg ? (liveStoryText ?? storyMsg.content) : "";
  const storyTurnId = storyMsg?.turnId;
  const storyKey = storyMsg ? (storyTurnId ?? storyMsg.id) : undefined;
  const isStreaming =
    executing && (storyMsg?.id.startsWith("stream_") ?? false);

  // ── Cross-layer state ─────────────────────────────────────────
  const [autoPlay, setAutoPlay] = useState(false);
  // A story already present when Stage mounts has been read in another view or
  // before a restore. Mark it read instead of replaying old text from scratch.
  // New story keys naturally fall back to the narrative dialog until it calls
  // `onAllRead`; no reset effect (and no first-render race) is required.
  const [readStoryKey, setReadStoryKey] = useState<string | undefined>(
    () => storyKey,
  );
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
  // Drop scene-prompts left over from a previous turn (StageChoices merges them
  // in via mergeChoices, which doesn't itself check freshness).
  const freshPrompts = useMemo(
    () => filterStalePrompts(promptsNamespace, storyTurnId),
    [promptsNamespace, storyTurnId],
  );
  const activeForm = pendingForms.find((m) => !dismissedFormIds.has(m.id));
  const fallbackRecap = useMemo(
    () => deriveDecisionRecapFallback(storyText),
    [storyText],
  );
  const allRead = Boolean(storyKey && readStoryKey === storyKey);
  // Keep the submitted decision visible, disabled and with progress feedback,
  // until the next narrative actually has text. This avoids a blank dialog
  // flash while the streaming placeholder exists but has no first delta yet.
  const waitingForNarrative =
    executing && storyText.trim().length === 0 && readStoryKey !== undefined;
  const choicesVisible = allRead || waitingForNarrative;
  const dialogVisible = !choicesVisible && storyText.trim().length > 0;

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
        retainWhenEmpty={
          directionCurrent === undefined && directionPreview === undefined
        }
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
          speakerName={speakers[0]?.name}
          autoPlay={autoPlay}
          reducedMotion={reducedMotion}
          onAllRead={() => setReadStoryKey(storyKey)}
        />
      )}
      <StageChoices
        visible={choicesVisible}
        executing={executing}
        interactionChoices={interactionChoices}
        promptsNamespace={freshPrompts}
        fallbackRecap={fallbackRecap}
        locale={locale}
        onSubmitInteraction={onSubmitInteraction}
        onSendMessage={onSendMessage}
      />

      {/* Initial generation has no previous decision panel to carry forward.
          Surface a quiet status pill until the first narrative delta arrives;
          subsequent turns show the disabled decision panel as feedback. */}
      {executing && !choicesVisible && storyText.trim().length === 0 && (
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

      {/* Execution error — a failed turn otherwise just stops the typewriter
          silently on stage; surface it with a retry affordance. */}
      {executionError && (
        <div
          className="pointer-events-none absolute inset-x-0 top-14 z-50 flex justify-center px-4"
          data-testid="stage-error"
        >
          <div className="ui-stage-panel pointer-events-auto flex max-w-2xl items-start gap-2 rounded-(--radius-card) border border-destructive/60 px-4 py-3 text-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-destructive">
                {t("common.error")}
              </p>
              <p className="mt-1 wrap-break-word text-xs text-muted-foreground">
                {executionError}
              </p>
            </div>
            {onRetryRuntime && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onRetryRuntime(undefined)}
              >
                {t("session.retryAll")}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* History drawer — the full parsed chat, needs a bounded flex column
          for its internal scroll viewport (flex-1 min-h-0). Zero out executionSteps
          / executionError so the drawer stays player-facing: the per-turn
          runtime timeline (dev timing chips) and the failed-turn banner belong
          on the stage itself, not in this narrative read-back. */}
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
              executionSteps={[]}
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
