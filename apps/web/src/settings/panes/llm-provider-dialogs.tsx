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
  draft,
  onOpenChange,
  onDraftChange,
  onSubmit,
}: {
  open: boolean;
  draft: ProviderDraft;
  onOpenChange: (open: boolean) => void;
  onDraftChange: (draft: ProviderDraft) => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("settings.addProvider", "Add provider")}</DialogTitle>
          <DialogDescription>
            {t(
              "settings.addProviderHint",
              "Configure the connection once and add one or more model IDs.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
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
            value={draft.protocol}
            onChange={(protocol) => onDraftChange({ ...draft, protocol })}
          />
          <ModelIdsTextarea
            value={draft.modelIds}
            onChange={(modelIds) => onDraftChange({ ...draft, modelIds })}
          />
        </div>
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
      </DialogContent>
    </Dialog>
  );
}

export function ModelDialog({
  open,
  providerId,
  value,
  onOpenChange,
  onChange,
  onSubmit,
}: {
  open: boolean;
  providerId: string;
  value: string;
  onOpenChange: (open: boolean) => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const count = parseModelIds(value).length;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
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
        <ModelIdsTextarea value={value} onChange={onChange} />
        <Button onClick={onSubmit} disabled={count === 0}>
          <Plus className="h-3.5 w-3.5" />
          {t("settings.addModelsCount", {
            count,
            defaultValue: "Add {{count}} model(s)",
          })}
        </Button>
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
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className="w-full border border-border bg-background px-2 py-1.5 text-xs outline-none disabled:bg-muted/30 disabled:text-muted-foreground focus:ring-1 focus:ring-primary"
    >
      <option value="openai-chat-v1">OpenAI Chat</option>
      <option value="openai-responses-v1">OpenAI Responses</option>
      <option value="anthropic-messages-v1">Anthropic Messages</option>
    </select>
  );
}
