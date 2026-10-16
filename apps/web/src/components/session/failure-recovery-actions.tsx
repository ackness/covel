import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button.js";
import { classifyActionableError } from "@/lib/actionable-error.js";

/** Fix settings first when retrying the same request cannot address its cause. */
export function FailureRecoveryActions({
  error,
  errorKind,
  retryLabel,
  disabled,
  onRetry,
  onOpenSettings,
}: {
  error?: string;
  errorKind?: string;
  retryLabel: string;
  disabled?: boolean;
  onRetry?: () => void;
  onOpenSettings: (key: "llm.providers" | "llm.slots") => void;
}) {
  const { t } = useTranslation();
  const kind = classifyActionableError(error, errorKind);
  const settingsFix = [
    "auth",
    "forbidden",
    "not-found",
    "rate-limited",
  ].includes(kind);
  return (
    <>
      {settingsFix && (
        <Button
          type="button"
          size="sm"
          disabled={disabled}
          onClick={() =>
            onOpenSettings(kind === "auth" ? "llm.providers" : "llm.slots")
          }
        >
          {t("session.recoveryModelSettings")}
        </Button>
      )}
      {onRetry && (
        <Button
          type="button"
          size="sm"
          variant={settingsFix ? "outline" : "default"}
          disabled={disabled}
          onClick={onRetry}
        >
          {retryLabel}
        </Button>
      )}
    </>
  );
}
