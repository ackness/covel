import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { primarySeat, type BaseActionKind } from "@covel/shared";
import { emitToast } from "@/lib/toast-channel.js";
import { sessionCharacters } from "@/lib/session-characters.js";
import type { SessionRecord } from "@/services/api.js";
import { useSession } from "@/stores/session-store.js";
import type { ActionFields } from "@/stores/session-store/composer-actions.js";
import {
  characterSwitcherOf,
  composerSeat,
  deriveComposerModes,
  modeAcceptsInput,
  type CharacterSwitcherModel,
  type ComposerMode,
} from "./composer-modes.js";

type FieldValues = Readonly<Record<string, unknown>>;

/** What the composer and the stage free input share about modes. */
export interface ComposerModes {
  readonly modes: readonly ComposerMode[];
  readonly mode: ComposerMode;
  readonly selectKind: (kind: string) => void;
  /** Values of the selected mode's fields, by property name. */
  readonly fieldValues: FieldValues;
  readonly setFieldValue: (name: string, value: unknown) => void;
  /** Changes whenever the field inputs must start over from `fieldValues`. */
  readonly fieldsKey: string;
  /**
   * Takes back a stopped submission's mode, fields and the queued selections
   * that rode ahead of it, which go out again with the next submission.
   */
  readonly restore: (restored: {
    kind?: string;
    fields?: ActionFields;
    drafts?: string;
  }) => void;
  readonly switcher: CharacterSwitcherModel | null;
  readonly switchCharacter: (characterId: string) => Promise<void>;
  /** Whether a submission with this text can be sent in the selected mode. */
  readonly acceptsInput: (text: string) => boolean;
  /**
   * Send the text in the selected mode, with queued selections ahead of it.
   * Returns false, with the reason shown, when nothing was sent.
   */
  readonly submit: (text: string, drafts?: string) => boolean;
}

/**
 * Mode state for one composer surface. Which kinds the seat may submit comes
 * from the session's action-kind catalogue; until it is read, `say` only.
 */
export function useComposerModes({
  session,
  executing,
  onSendMessage,
}: {
  session: SessionRecord;
  executing: boolean;
  onSendMessage: (content: string) => void;
}): ComposerModes {
  const { t, i18n } = useTranslation();
  const {
    state: sessionState,
    submitComposerAction,
    switchSeatCharacter,
  } = useSession();
  const catalogue = sessionState.sessionActionKinds ?? null;
  const gameState = sessionState.gameState;
  const seats = session.seats;
  const language = i18n.language;
  const [selected, setSelected] = useState<{
    kind: string;
    values: FieldValues;
    generation: number;
    /** Selections taken back from a stopped submission, not yet sent again. */
    restoredDrafts?: string;
  }>({ kind: "say", values: {}, generation: 0 });

  const baseLabel = useCallback(
    (kind: BaseActionKind) => t(`session.actionKind.${kind}`),
    [t],
  );
  const modes = useMemo(
    () => deriveComposerModes({ catalogue, seats, language, baseLabel }),
    [catalogue, seats, language, baseLabel],
  );
  // A mode that left the catalogue gives way to the first one.
  const mode = modes.find((m) => m.kind === selected.kind) ?? modes[0]!;
  // A checkbox shows unchecked until it is touched, and unchecked is `false`:
  // the value the form displays is the value that is validated and sent.
  const fieldValues = useMemo<FieldValues>(
    () => ({
      ...Object.fromEntries(
        mode.fields
          .filter((field) => field.control === "checkbox")
          .map((field) => [field.name, false]),
      ),
      ...(mode.kind === selected.kind ? selected.values : {}),
    }),
    [mode, selected.kind, selected.values],
  );

  const selectKind = useCallback((kind: string) => {
    setSelected((current) => ({
      ...current,
      kind,
      values: {},
      generation: current.generation + 1,
    }));
  }, []);
  const setFieldValue = useCallback((name: string, value: unknown) => {
    setSelected((current) => ({
      ...current,
      values: { ...current.values, [name]: value },
    }));
  }, []);
  const restore = useCallback(
    ({
      kind,
      fields,
      drafts,
    }: {
      kind?: string;
      fields?: ActionFields;
      drafts?: string;
    }) => {
      if (!kind) return;
      setSelected((current) => ({
        kind,
        values: fields ?? {},
        generation: current.generation + 1,
        ...(drafts ? { restoredDrafts: drafts } : {}),
      }));
    },
    [],
  );

  const characters = useMemo(
    () => sessionCharacters(gameState ?? {}),
    [gameState],
  );
  const switcher = useMemo(
    () => (mode.actor ? characterSwitcherOf(seats, characters) : null),
    [mode.actor, seats, characters],
  );
  const switchCharacter = useCallback(
    async (characterId: string) => {
      if (!switcher || executing) return;
      try {
        await switchSeatCharacter(switcher.seatId, characterId);
      } catch (error) {
        emitToast(
          "error",
          t("session.switchCharacterFailed", "Could not switch character"),
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [executing, switchSeatCharacter, switcher, t],
  );

  const acceptsInput = useCallback(
    (text: string) => modeAcceptsInput(mode, text),
    [mode],
  );

  const submit = useCallback(
    (text: string, queued?: string): boolean => {
      const drafts =
        [selected.restoredDrafts, queued].filter(Boolean).join("\n") ||
        undefined;
      const joined = [drafts ?? "", text].filter(Boolean).join("\n");
      // Slash lines keep the command path in every mode, and a `say` is the
      // plain text request it always was.
      if (
        mode.kind === "say" ||
        text.startsWith("/") ||
        !modeAcceptsInput(mode, text)
      ) {
        if (!joined) return false;
        onSendMessage(joined);
        setSelected(({ restoredDrafts: _sent, ...current }) => current);
        return true;
      }
      const missing = mode.fields.filter((field) => {
        if (!field.required) return false;
        const value = fieldValues[field.name];
        return (
          value === undefined ||
          value === null ||
          (typeof value === "string" && !value.trim()) ||
          (typeof value === "number" && !Number.isFinite(value))
        );
      });
      if (missing.length > 0) {
        emitToast(
          "error",
          t("form.requiredMissing", "Please fill in required fields"),
          new Intl.ListFormat(language, {
            style: "narrow",
            type: "unit",
          }).format(missing.map((field) => field.label)),
        );
        return false;
      }
      const seat = composerSeat(seats);
      const fields = mode.fields.flatMap((field) => {
        const value = fieldValues[field.name];
        if (
          value === undefined ||
          value === null ||
          value === "" ||
          (typeof value === "number" && !Number.isFinite(value))
        )
          return [];
        return [[field.name, value] as const];
      });
      const trimmed = text.trim();
      submitComposerAction(
        {
          kind: mode.kind,
          ...(mode.text !== "none" && trimmed ? { text: trimmed } : {}),
          ...(fields.length > 0
            ? { fields: Object.fromEntries(fields) as ActionFields }
            : {}),
          ...(seat && seat !== primarySeat(seats) ? { seatId: seat.id } : {}),
        },
        drafts ? { drafts } : undefined,
      );
      setSelected(({ restoredDrafts: _sent, ...current }) => ({
        ...current,
        values: {},
        generation: current.generation + 1,
      }));
      return true;
    },
    [
      selected.restoredDrafts,
      fieldValues,
      language,
      mode,
      onSendMessage,
      seats,
      submitComposerAction,
      t,
    ],
  );

  return useMemo(
    () => ({
      modes,
      mode,
      selectKind,
      fieldValues,
      setFieldValue,
      fieldsKey: `${mode.kind}:${selected.generation}`,
      restore,
      switcher,
      switchCharacter,
      acceptsInput,
      submit,
    }),
    [
      modes,
      mode,
      selectKind,
      fieldValues,
      setFieldValue,
      selected.generation,
      restore,
      switcher,
      switchCharacter,
      acceptsInput,
      submit,
    ],
  );
}
