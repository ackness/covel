import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  parseSlashCommandInvocation,
  type SessionSlashCommand,
} from "@covel/shared";
import { useSession, type StreamMessage } from "@/stores/session-store.js";
import { isPreGameSession } from "@/stores/session-store/selectors.js";
import type { SessionRecord } from "@/services/api.js";
import { postPluginRpcWithApproval } from "../plugin-rpc-ui.js";
import { requestConfirm } from "@/lib/confirm-channel.js";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import { isPendingInteractionMessage } from "./interaction-blocks.js";
import {
  commandAcceptsTypedName,
  completeSlashCommand,
  matchSlashCommands,
  readSlashCommandQuery,
} from "./slash-command.js";

export interface CommandFeedback {
  readonly tone: "info" | "error";
  readonly message: string;
}

export interface CommandClientAction {
  readonly type: string;
  readonly pluginId?: string;
  readonly panelId?: string;
}

interface UseGameViewComposerArgs {
  messages: StreamMessage[];
  submittedBlockIds: ReadonlySet<string>;
  executing: boolean;
  session: SessionRecord;
  onSendMessage: (content: string) => void;
  commands?: readonly SessionSlashCommand[];
  onCommandClientAction?: (action: CommandClientAction) => void;
}

export function useGameViewComposer({
  messages,
  submittedBlockIds,
  executing,
  session,
  onSendMessage,
  commands = [],
  onCommandClientAction,
}: UseGameViewComposerArgs) {
  const { t, i18n } = useTranslation();
  const [inputValue, setInputValue] = useState("");
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [commandExecuting, setCommandExecuting] = useState(false);
  const [commandFeedback, setCommandFeedback] =
    useState<CommandFeedback | null>(null);

  const {
    state: sessionState,
    clearInteractionDrafts,
    removeInteractionDraft,
    submitBlock,
    resumeSuspension,
    cancelSuspension,
    steerMessage,
    abortActiveTurn,
    loadSessionPlugins,
  } = useSession();

  const commandQuery = useMemo(
    () => readSlashCommandQuery(inputValue),
    [inputValue],
  );
  const commandMatches = useMemo(
    () => matchSlashCommands(commands, inputValue).slice(0, 8),
    [commands, inputValue],
  );
  const commandMenuOpen =
    commandQuery !== null && !commandMenuDismissed && !commandExecuting;
  const selectedCommand = commandMatches[selectedCommandIndex];

  useEffect(() => {
    setSelectedCommandIndex(0);
  }, [commandQuery?.name, commandQuery?.hasArguments, commands]);

  const handleInputValueChange = useCallback((value: string) => {
    setInputValue(value);
    setCommandMenuDismissed(false);
    setCommandFeedback(null);
  }, []);

  const pendingDrafts = sessionState.pendingInteractionDrafts;
  const suspensions = sessionState.suspensions;
  const hasActiveInteractionBlock = useMemo(
    () =>
      messages.some((msg) =>
        isPendingInteractionMessage(msg, messages, submittedBlockIds),
      ),
    [messages, submittedBlockIds],
  );
  // Only a must-answer block (form / choice) locks the composer. Queued
  // suggestion drafts don't: the player can keep typing, and submitting sends
  // the selections and the typed line together as one turn.
  const composerBlocked = hasActiveInteractionBlock;
  /**
   * The "begin adventure" hero is still on screen. Its render condition is
   * mirrored here on purpose — sending a message in this state would open a
   * turn before any setup runtime has run, so the narrator would be answering
   * in a world with no character and no opening scene.
   */
  const awaitingBegin =
    isPreGameSession(session) && messages.length === 0 && !executing;
  // While a turn is executing the composer stays usable — submitting
  // steers the in-flight turn instead of starting a new one.
  const composerDisabled = composerBlocked || awaitingBegin;

  const commitDrafts = useCallback(
    (extraText?: string) => {
      if (pendingDrafts.length === 0) return;
      const combined = [
        ...pendingDrafts.map((d) =>
          String(d.values?.text ?? d.label ?? "").trim(),
        ),
        extraText ?? "",
      ]
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
        submitBlock(blockId, {
          _kind: "selection",
          _label: labelSummary,
          items,
        });
      }
      onSendMessage(combined);
      clearInteractionDrafts();
    },
    [pendingDrafts, clearInteractionDrafts, onSendMessage, submitBlock],
  );

  const handleConfirmDrafts = useCallback(() => commitDrafts(), [commitDrafts]);

  const applyCommandCompletion = useCallback((command: SessionSlashCommand) => {
    setInputValue(completeSlashCommand(command));
    setCommandMenuDismissed(false);
    setSelectedCommandIndex(0);
  }, []);

  const runSlashCommand = useCallback(
    async (command: SessionSlashCommand, raw: string) => {
      const parsed = parseSlashCommandInvocation(command, raw);
      if (!parsed.ok) {
        setCommandFeedback({ tone: "error", message: parsed.message });
        return;
      }
      setCommandExecuting(true);
      setCommandFeedback(null);
      try {
        const response = await postPluginRpcWithApproval({
          sessionId: session.id,
          request: { kind: "command", commandId: command.id, input: raw },
          pluginId: command.pluginId,
          actionLabel: `/${command.name}`,
          confirm: requestConfirm,
          t,
        });
        if (!response) return;
        if (response.status !== "ok") {
          setCommandFeedback({
            tone: "info",
            message: t("session.commandAccepted", "Command accepted."),
          });
          setInputValue("");
          return;
        }

        const result =
          response.result && typeof response.result === "object"
            ? (response.result as Record<string, unknown>)
            : undefined;
        if (result?.ok === false) {
          setCommandFeedback({
            tone: "error",
            message:
              resolveDisplayText(
                result.message ?? result.reason,
                i18n.language,
              ) || t("session.commandFailed", "Command failed."),
          });
          return;
        }
        const message = resolveDisplayText(result?.message, i18n.language);
        setCommandFeedback({
          tone: "info",
          message:
            message ||
            t("session.commandCompleted", {
              command: `/${command.name}`,
              defaultValue: "{{command}} completed.",
            }),
        });
        setInputValue("");
        setCommandMenuDismissed(true);

        const clientAction = result?.clientAction;
        if (
          clientAction &&
          typeof clientAction === "object" &&
          !Array.isArray(clientAction)
        ) {
          const action = clientAction as Record<string, unknown>;
          if (typeof action.type === "string") {
            onCommandClientAction?.({
              type: action.type,
              pluginId: command.pluginId,
              ...(typeof action.panelId === "string"
                ? { panelId: action.panelId }
                : {}),
            });
          }
        }
      } catch (error) {
        setCommandFeedback({
          tone: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setCommandExecuting(false);
        await loadSessionPlugins();
      }
    },
    [i18n.language, loadSessionPlugins, onCommandClientAction, session.id, t],
  );

  const handleSubmit = useCallback(() => {
    const val = inputValue.trim();
    if (!val || composerDisabled || commandExecuting) return;
    if (commandQuery && selectedCommand) {
      if (!commandAcceptsTypedName(selectedCommand, val)) {
        if (!commandMenuDismissed) applyCommandCompletion(selectedCommand);
        return;
      }
      void runSlashCommand(selectedCommand, val);
      return;
    }
    // Queued selections ride along with the typed line as a single turn.
    if (!executing && pendingDrafts.length > 0) {
      setInputValue("");
      commitDrafts(val);
      return;
    }
    if (executing) {
      // Steer the in-flight turn; on failure (e.g. the turn ended first — 409)
      // restore the steered text to the composer so the player can re-send it.
      // Merge with anything typed during the round-trip instead of dropping it:
      // steered text first, newer draft after.
      setInputValue("");
      void steerMessage(val)
        .then((ok) => {
          if (!ok) {
            setInputValue((current) => (current ? `${val}\n${current}` : val));
          }
        })
        .catch(() => {
          setInputValue((current) => (current ? `${val}\n${current}` : val));
        });
      return;
    }
    onSendMessage(val);
    setInputValue("");
  }, [
    inputValue,
    composerDisabled,
    commandExecuting,
    commandQuery,
    selectedCommand,
    commandMenuDismissed,
    applyCommandCompletion,
    runSlashCommand,
    executing,
    pendingDrafts.length,
    commitDrafts,
    steerMessage,
    onSendMessage,
  ]);

  const handleAbort = useCallback(() => {
    void abortActiveTurn().catch(() => {
      // The API transport already surfaced the actionable failure.
    });
  }, [abortActiveTurn]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.nativeEvent.isComposing) return;
      if (commandMenuOpen) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          if (commandMatches.length > 0) {
            setSelectedCommandIndex((current) =>
              e.key === "ArrowDown"
                ? (current + 1) % commandMatches.length
                : (current - 1 + commandMatches.length) % commandMatches.length,
            );
          }
          return;
        }
        if (e.key === "Tab" && selectedCommand) {
          e.preventDefault();
          applyCommandCompletion(selectedCommand);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setCommandMenuDismissed(true);
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [
      applyCommandCompletion,
      commandMatches.length,
      commandMenuOpen,
      handleSubmit,
      selectedCommand,
    ],
  );

  return {
    inputValue,
    setInputValue: handleInputValueChange,
    pendingDrafts,
    suspensions,
    composerBlocked,
    composerDisabled,
    awaitingBegin,
    commandMatches,
    commandMenuOpen,
    selectedCommandIndex,
    commandExecuting,
    commandFeedback,
    applyCommandCompletion,
    handleConfirmDrafts,
    handleSubmit,
    handleAbort,
    handleKeyDown,
    removeInteractionDraft,
    resumeSuspension,
    cancelSuspension,
  };
}
