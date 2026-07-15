import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff, KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import {
  clearOperatorToken,
  getOperatorToken,
  storeOperatorToken,
} from "@/services/session-credentials.js";

interface OperatorAccessPaneProps {
  /** Reloads hosted data after the credential changes. Injectable for tests. */
  onCredentialChange?: () => void;
}

function reloadAfterCredentialChange(): void {
  window.location.reload();
}

/**
 * Browser-local credential entry point for hosted administrative requests.
 *
 * The token is never fetched from the server or embedded in the web bundle.
 * Operators paste it explicitly; storage and request propagation remain
 * same-origin browser concerns. Self-tier servers ignore the extra header.
 */
export function OperatorAccessPane({
  onCredentialChange = reloadAfterCredentialChange,
}: OperatorAccessPaneProps) {
  const { t } = useTranslation();
  const [token, setToken] = useState(() => getOperatorToken() ?? "");
  const [configured, setConfigured] = useState(
    () => getOperatorToken() !== undefined,
  );
  const [visible, setVisible] = useState(false);
  const normalizedToken = token.trim();

  function save(): void {
    if (!normalizedToken) return;
    storeOperatorToken(normalizedToken);
    setConfigured(true);
    onCredentialChange();
  }

  function clear(): void {
    clearOperatorToken();
    setToken("");
    setConfigured(false);
    onCredentialChange();
  }

  return (
    <div className="space-y-5">
      <div className="border border-border p-4 space-y-2">
        <div className="flex items-start gap-3">
          <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium">
                {t("settings.operatorAccessTitle")}
              </h3>
              <Badge variant={configured ? "default" : "outline"}>
                {configured
                  ? t("settings.operatorAccessConfigured")
                  : t("settings.operatorAccessUnconfigured")}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t("settings.operatorAccessDescription")}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <Label
          htmlFor="operator-token"
          className="text-xs uppercase tracking-widest text-muted-foreground"
        >
          {t("settings.operatorTokenLabel")}
        </Label>
        <div className="flex gap-1">
          <input
            id="operator-token"
            type={visible ? "text" : "password"}
            autoComplete="current-password"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={t("settings.operatorTokenPlaceholder")}
            className="flex-1 min-w-0 bg-background border border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary font-mono"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setVisible((value) => !value)}
            aria-label={visible ? t("settings.hide") : t("settings.show")}
          >
            {visible ? (
              <EyeOff className="w-3.5 h-3.5" />
            ) : (
              <Eye className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          {t("settings.operatorTokenStorageHint")}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!normalizedToken}
          onClick={save}
        >
          <KeyRound className="w-3.5 h-3.5" />
          {t("settings.operatorTokenSave")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!configured}
          onClick={clear}
        >
          <Trash2 className="w-3.5 h-3.5" />
          {t("settings.operatorTokenClear")}
        </Button>
      </div>
    </div>
  );
}
