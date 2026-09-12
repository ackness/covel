import { BookOpen, Globe, MessageSquare, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button.js";
import { PingButton } from "@/components/shared/ping-button.js";
import { formatSlotLabel, type ResolvedSlot } from "@/hooks/use-slot-config.js";

export function WelcomeStep() {
  const { t } = useTranslation();
  return (
    <div className="rounded-(--radius-card) border border-border bg-muted/30 p-4 space-y-3">
      <BookOpen className="h-6 w-6 text-primary" aria-hidden />
      <p className="text-sm leading-relaxed">{t("onboarding.welcomeRoute")}</p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("onboarding.existingSettingsHint")}
      </p>
    </div>
  );
}

interface SettingsActionProps {
  onOpenSettings: (key: string) => void;
}

export function ModelStep({
  slots,
  onOpenSettings,
}: SettingsActionProps & { slots: ResolvedSlot[] }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <section className="rounded-(--radius-card) border border-border p-4 space-y-3">
        <p className="text-sm font-medium" role="status">
          {t(
            slots.length
              ? "onboarding.modelsDetected"
              : "onboarding.modelsMissing",
          )}
        </p>
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t(
            slots.length
              ? "onboarding.modelsDetectedHint"
              : "onboarding.modelsMissingHint",
          )}
        </p>
        {slots.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs font-medium text-primary">
              {t("onboarding.testBindings", { count: slots.length })}
            </summary>
            <ul className="mt-3 space-y-3">
              {slots.map((slot) => (
                <li
                  key={slot.slotId}
                  className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2"
                >
                  <div className="min-w-0 flex-1 text-xs">
                    <p className="font-medium break-all">{slot.slotId}</p>
                    <p className="text-muted-foreground break-all">
                      {formatSlotLabel(slot)}
                    </p>
                  </div>
                  <PingButton target={{ kind: "slot", slotId: slot.slotId }} />
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => onOpenSettings("llm.providers")}>
          <Settings2 className="h-4 w-4" aria-hidden />
          {t("session.configureKeys")}
        </Button>
        <Button variant="outline" onClick={() => onOpenSettings("llm.slots")}>
          {t("onboarding.checkBindings", { roles: t("settings.llmSlots") })}
        </Button>
      </div>
      <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed">
        <li>
          {t("onboarding.providerInstruction", {
            providers: t("session.configureKeys"),
          })}
        </li>
        <li>{t("onboarding.connectionInstruction")}</li>
        <li>
          {t("onboarding.bindingInstruction", {
            roles: t("settings.llmSlots"),
          })}
        </li>
      </ol>
      <p className="text-xs text-muted-foreground">
        {t("onboarding.returnFromSettings")}
      </p>
    </div>
  );
}

export function PlayStep({
  hasModel,
  onOpenSettings,
}: SettingsActionProps & { hasModel: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      {!hasModel && (
        <div
          role="status"
          className="rounded-(--radius-card) border border-border bg-muted/30 p-3 text-xs leading-relaxed"
        >
          <p>{t("onboarding.browseOnlyHint")}</p>
          <Button
            variant="link"
            className="h-auto px-0 py-1"
            onClick={() => onOpenSettings("llm.providers")}
          >
            {t("session.configureKeys")}
          </Button>
        </div>
      )}
      <ol className="space-y-4">
        {[
          {
            icon: Globe,
            title: "chooseWorldTitle",
            description: "chooseWorldDesc",
          },
          {
            icon: Settings2,
            title: "prepareTitle",
            description: "prepareDesc",
          },
          {
            icon: MessageSquare,
            title: "interactTitle",
            description: "interactDesc",
          },
        ].map(({ icon: Icon, title, description }, index) => (
          <li key={title} className="flex gap-3">
            <Icon
              className="mt-0.5 h-5 w-5 shrink-0 text-primary"
              aria-hidden
            />
            <div className="space-y-1">
              <h3 className="text-sm font-medium">
                {index + 1}. {t(`onboarding.${title}`)}
              </h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t(`onboarding.${description}`, {
                  advanced: t("session.advancedPluginSettings"),
                })}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <details className="rounded-(--radius-card) border border-border p-3 text-xs">
        <summary className="cursor-pointer font-medium">
          {t("onboarding.duringTurnTitle")}
        </summary>
        <p className="mt-2 leading-relaxed text-muted-foreground">
          {t("onboarding.duringTurnDesc")}
        </p>
      </details>
      <p className="text-xs text-muted-foreground">
        {t("onboarding.reopenHint")}
      </p>
    </div>
  );
}
