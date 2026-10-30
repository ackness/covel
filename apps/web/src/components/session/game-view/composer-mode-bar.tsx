import type { TFunction } from "i18next";
import { resolveIcon } from "@/lib/catalog/helpers.js";
import { CharacterSwitcher } from "./character-switcher.js";
import type { ComposerModes } from "./use-composer-modes.js";

interface ComposerModeBarProps {
  t: TFunction;
  composerModes: ComposerModes;
  executing: boolean;
}

/**
 * The mode picker and the character switcher above an input. The picker is
 * left out when the seat has one mode, the switcher when it binds one
 * character or the mode is not taken as a character.
 */
export function ComposerModeBar({
  t,
  composerModes,
  executing,
}: ComposerModeBarProps) {
  const { modes, mode, selectKind, switcher, switchCharacter } = composerModes;
  if (modes.length < 2 && !switcher) return null;
  return (
    <div
      data-testid="composer-mode-bar"
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 pb-2"
    >
      {modes.length > 1 && (
        <div
          role="radiogroup"
          aria-label={t("session.composerMode", "Input mode")}
          className="flex min-w-0 flex-wrap items-center gap-1"
        >
          {modes.map((candidate) => {
            const Icon = resolveIcon(candidate.icon);
            const selected = candidate.kind === mode.kind;
            return (
              <button
                key={candidate.kind}
                type="button"
                role="radio"
                aria-checked={selected}
                data-testid={`composer-mode-${candidate.kind}`}
                onClick={() => selectKind(candidate.kind)}
                className={`ui-tag inline-flex items-center gap-1 px-2 py-1 text-xs transition-colors ${
                  selected
                    ? "bg-[color-mix(in_oklab,var(--accent-primary)_14%,transparent)] text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {Icon && <Icon className="h-3 w-3" aria-hidden="true" />}
                {candidate.label}
              </button>
            );
          })}
        </div>
      )}
      {switcher && (
        <CharacterSwitcher
          t={t}
          switcher={switcher}
          disabled={executing}
          onSwitch={(characterId) => void switchCharacter(characterId)}
        />
      )}
    </div>
  );
}
