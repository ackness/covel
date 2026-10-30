import type { TFunction } from "i18next";
import type { CharacterSwitcherModel } from "./composer-modes.js";

interface CharacterSwitcherProps {
  t: TFunction;
  switcher: CharacterSwitcherModel;
  /** The route waits for the session lock, so it is off while a turn runs. */
  disabled: boolean;
  onSwitch: (characterId: string) => void;
}

/**
 * The seat's current character. A seat that plays several characters acts as
 * the chosen one from the next turn on.
 */
export function CharacterSwitcher({
  t,
  switcher,
  disabled,
  onSwitch,
}: CharacterSwitcherProps) {
  return (
    <label className="ui-meta inline-flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
      <span className="shrink-0">{t("session.actingAs", "Acting as")}</span>
      <select
        data-testid="composer-character-switcher"
        aria-label={t("session.switchCharacter", "Switch character")}
        value={switcher.currentId ?? ""}
        disabled={disabled}
        onChange={(event) => onSwitch(event.target.value)}
        className="min-w-0 max-w-40 truncate rounded-sm border border-(--rule-color) bg-(--surface-inset) px-1.5 py-0.5 text-xs text-foreground outline-none focus:border-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50"
      >
        {switcher.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name || t("session.player", "Player")}
          </option>
        ))}
      </select>
    </label>
  );
}
