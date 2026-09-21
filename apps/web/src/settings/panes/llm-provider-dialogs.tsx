import type { ReasoningEffort } from "@/services/api.js";
import {
  getBuiltinProviderConnection,
  protocolOutputModalities,
} from "@covel/shared";
import { ImportedModelReasoning } from "./model-reasoning-settings.js";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { parseModelIds, type ProviderDraft } from "./llm-provider-catalog.js";

export function ProviderDialog({
  open,
  busy,
  error,
  draft,
  onOpenChange,
  onDraftChange,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string | null;
  draft: ProviderDraft;
  onOpenChange: (open: boolean) => void;
  onDraftChange: (draft: ProviderDraft) => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("settings.addProvider", "Add provider")}</DialogTitle>
          <DialogDescription>
            {t(
              "settings.addProviderHint",
              "Configure the connection once and add one or more model IDs.",
            )}
          </DialogDescription>
        </DialogHeader>
        <fieldset disabled={busy} className="min-w-0 space-y-3">
          <input
            value={draft.providerId}
            onChange={(event) =>
              onDraftChange({ ...draft, providerId: event.target.value })
            }
            placeholder={t("settings.providerIdExample")}
            className="w-full border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            value={draft.baseUrl}
            onChange={(event) =>
              onDraftChange({ ...draft, baseUrl: event.target.value })
            }
            placeholder={t("settings.baseUrlPlaceholder")}
            className="w-full border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-1 focus:ring-primary"
          />
          <ProtocolSelect
            provider={draft.providerId}
            inheritLabel={t("settings.providerProtocolDefault")}
            value={draft.protocol}
            onChange={(protocol) => onDraftChange({ ...draft, protocol })}
          />
          <ModelIdsTextarea
            value={draft.modelIds}
            onChange={(modelIds) => onDraftChange({ ...draft, modelIds })}
          />
          <ImportedModelReasoning
            modelIds={draft.modelIds}
            provider={draft.providerId}
            protocol={draft.protocol}
            values={draft.reasoningDefaults ?? {}}
            onChange={(reasoningDefaults) =>
              onDraftChange({ ...draft, reasoningDefaults })
            }
          />
          <Button
            onClick={onSubmit}
            disabled={
              !draft.providerId.trim() ||
              parseModelIds(draft.modelIds).length === 0
            }
          >
            <Plus className="h-3.5 w-3.5" />
            {t("settings.addProvider", "Add provider")}
          </Button>
        </fieldset>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ModelDialog({
  open,
  busy,
  error,
  providerId,
  provider,
  protocol,
  modelProtocol,
  onProtocolChange,
  reasoningDefaults,
  onReasoningChange,
  value,
  onOpenChange,
  onChange,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string | null;
  providerId: string;
  provider?: string;
  protocol?: string;
  modelProtocol: string;
  onProtocolChange: (value: string) => void;
  reasoningDefaults: Record<string, ReasoningEffort | undefined>;
  onReasoningChange: (
    values: Record<string, ReasoningEffort | undefined>,
  ) => void;
  value: string;
  onOpenChange: (open: boolean) => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const count = parseModelIds(value).length;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("settings.addModel", "Add model")}</DialogTitle>
          <DialogDescription>
            {t("settings.addModelsToProvider", {
              provider: providerId,
              defaultValue:
                "Add model IDs to {{provider}}. IDs are sent unchanged.",
            })}
          </DialogDescription>
        </DialogHeader>
        <fieldset disabled={busy} className="min-w-0 space-y-3">
          <ModelIdsTextarea value={value} onChange={onChange} />
          <ProtocolSelect
            provider={provider ?? providerId}
            inheritedProtocol={protocol}
            value={modelProtocol}
            onChange={onProtocolChange}
            inheritLabel={t("settings.inheritProviderProtocol")}
          />
          <ImportedModelReasoning
            modelIds={value}
            provider={providerId}
            protocol={modelProtocol || protocol}
            values={reasoningDefaults}
            onChange={onReasoningChange}
          />
          <Button onClick={onSubmit} disabled={count === 0}>
            <Plus className="h-3.5 w-3.5" />
            {t("settings.addModelsCount", {
              count,
              defaultValue: "Add {{count}} model(s)",
            })}
          </Button>
        </fieldset>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ModelIdsTextarea({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium">
        {t("settings.modelIds", "Model IDs")}
      </span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={6}
        placeholder={"openai/gpt-5.6-sol\ndeepseek/deepseek-v4-flash"}
        className="w-full resize-y border border-border bg-background px-3 py-2 font-mono text-sm leading-relaxed outline-none focus:ring-1 focus:ring-primary"
      />
      <span className="block text-[10px] text-muted-foreground">
        {t(
          "settings.modelIdsPerLineHint",
          "Enter one model ID per line. Empty lines and duplicates are ignored.",
        )}
      </span>
    </label>
  );
}

export function ProtocolSelect({
  value,
  onChange,
  disabled = false,
  inheritLabel,
  provider,
  inheritedProtocol,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  inheritLabel?: string;
  provider?: string;
  inheritedProtocol?: string;
}) {
  const { t } = useTranslation();
  const evaluation = protocolOutputModalities(value).includes("evaluation");
  const selectEvaluation = () =>
    inheritedProtocol &&
    protocolOutputModalities(inheritedProtocol).includes("evaluation")
      ? inheritedProtocol
      : (getBuiltinProviderConnection(provider ?? "")?.evaluationProtocol ??
        "typesafe-systemone-v1");
  const selectClassName =
    "w-full border border-border bg-background px-2 py-1.5 text-xs outline-none disabled:bg-muted/30 disabled:text-muted-foreground focus:ring-1 focus:ring-primary";
  return (
    <div className="space-y-2">
      <label className="block space-y-1 text-xs">
        <span>{t("settings.protocol")}</span>
        <select
          value={evaluation ? "evaluation" : value}
          disabled={disabled}
          onChange={(event) =>
            onChange(
              event.target.value === "evaluation"
                ? selectEvaluation()
                : event.target.value,
            )
          }
          className={selectClassName}
        >
          {inheritLabel && <option value="">{inheritLabel}</option>}
          <option value="openai-chat-v1">OpenAI Chat</option>
          <option value="openai-responses-v1">OpenAI Responses</option>
          <option value="anthropic-messages-v1">Anthropic Messages</option>
          <option value="evaluation">{t("settings.evaluationProtocol")}</option>
        </select>
      </label>
      {evaluation && (
        <div className="space-y-1 border-l border-border pl-3">
          <label className="block space-y-1 text-xs">
            <span>{t("settings.evaluationApi")}</span>
            <select
              value={value}
              disabled={disabled}
              onChange={(event) => onChange(event.target.value)}
              className={selectClassName}
            >
              <option value="typesafe-systemone-v1">TypeSafe System One</option>
              <option value="openrouter-decisions-v1">
                OpenRouter Decisions
              </option>
              <option value="vercel-evaluation-v4">Vercel AI Gateway</option>
            </select>
          </label>
          <p className="text-[10px] text-muted-foreground">
            {t("settings.evaluationApiHint")}
          </p>
        </div>
      )}
    </div>
  );
}
