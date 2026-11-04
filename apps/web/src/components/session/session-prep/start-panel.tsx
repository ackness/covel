import { Loader2, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SeatRole } from "@covel/shared";
import { Button } from "@/components/ui/button.js";

export type ModelLine =
  | { readonly kind: "ready"; readonly model: string }
  | { readonly kind: "no-key" }
  | { readonly kind: "none" };

interface StartPanelProps {
  readonly isStarting: boolean;
  readonly canStart: boolean;
  readonly onStart: () => void;
  readonly roles: readonly SeatRole[];
  readonly seatRole: SeatRole;
  readonly onSeatRoleChange: (role: SeatRole) => void;
  readonly model: ModelLine;
  /** Opens Settings → Models, the one place to change the model. */
  readonly onChangeModel: () => void;
  readonly customOpen: boolean;
  readonly onToggleCustom: () => void;
}

const ROLE_KEYS: Readonly<Record<SeatRole, string>> = {
  player: "Player",
  host: "Host",
  spectator: "Spectator",
};

/**
 * What a player needs to begin: Start, who they play as when there is a
 * choice, which model will run, and a way into the custom setup.
 */
export function StartPanel(props: StartPanelProps) {
  const { t } = useTranslation();
  return (
    <section
      data-testid="start-panel"
      className="mb-6 space-y-3 rounded-(--radius-card) border border-border bg-card px-4 py-4 md:px-5"
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Button
          size="lg"
          className="h-11 shrink-0 px-7 font-semibold"
          disabled={!props.canStart}
          onClick={props.onStart}
        >
          {props.isStarting ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Play className="mr-1.5 h-4 w-4" />
          )}
          {props.isStarting
            ? t("session.startingGame", "Creating…")
            : t("session.startGame", "Start Game")}
        </Button>
        {props.roles.length > 1 && (
          <fieldset
            className="min-w-0 flex-1"
            disabled={props.isStarting}
            data-testid="seat-role"
          >
            <legend className="sr-only">{t("session.playAs")}</legend>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {props.roles.map((role) => (
                <label
                  key={role}
                  className="flex cursor-pointer items-center gap-1.5 text-sm"
                >
                  <input
                    type="radio"
                    name="seat-role"
                    value={role}
                    checked={props.seatRole === role}
                    onChange={() => props.onSeatRoleChange(role)}
                  />
                  {t(`session.role${ROLE_KEYS[role]}`)}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(`session.role${ROLE_KEYS[props.seatRole]}Hint`)}
            </p>
          </fieldset>
        )}
      </div>

      <p
        className={`text-sm ${
          props.model.kind === "ready"
            ? "text-muted-foreground"
            : "text-destructive"
        }`}
        role={props.model.kind === "ready" ? undefined : "status"}
        data-testid="model-line"
      >
        {props.model.kind === "ready"
          ? t("session.modelLineUsing", { model: props.model.model })
          : props.model.kind === "no-key"
            ? t("session.modelLineNoKey")
            : t("session.modelLineNone")}{" "}
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 align-baseline text-sm"
          onClick={props.onChangeModel}
        >
          {props.model.kind === "ready"
            ? t("session.modelLineChange")
            : t("session.modelLineSetUp")}
        </Button>
      </p>

      <p className="text-sm text-muted-foreground">
        {props.customOpen
          ? t("session.customStartOpen")
          : t("session.recommendedSettings")}{" "}
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 align-baseline text-sm"
          aria-expanded={props.customOpen}
          aria-controls="custom-start-content"
          onClick={props.onToggleCustom}
        >
          {props.customOpen
            ? t("session.customStartHide")
            : t("session.customStartShow")}
        </Button>
      </p>
    </section>
  );
}
