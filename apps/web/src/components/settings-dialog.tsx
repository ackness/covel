import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, Check } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getProviderKeys, setProviderKeys } from "@/services/api";
import { useSession } from "@/stores/session-store";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Known providers we support */
const PROVIDERS = [
  { id: "deepseek", name: "DeepSeek", placeholder: "sk-..." },
  { id: "dashscope", name: "DashScope (Qwen)", placeholder: "sk-..." },
  { id: "openai", name: "OpenAI", placeholder: "sk-..." },
] as const;

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { t } = useTranslation();
  const { state } = useSession();
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (open) {
      setKeys(getProviderKeys());
      setSaved(false);
    }
  }, [open]);

  const handleSave = () => {
    // Remove empty keys
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(keys)) {
      if (v.trim()) cleaned[k] = v.trim();
    }
    setProviderKeys(cleaned);
    setSaved(true);
    setTimeout(() => onOpenChange(false), 600);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm uppercase tracking-widest">
            <KeyRound className="w-4 h-4" />
            {t("nav.settings", "Settings")}
          </DialogTitle>
          <DialogDescription>
            Configure API keys for LLM providers. Keys are stored locally in your browser.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {/* Provider API Keys */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              API Keys
            </h4>
            {PROVIDERS.map((provider) => (
              <div key={provider.id} className="space-y-1.5">
                <Label htmlFor={`key-${provider.id}`} className="text-xs">
                  {provider.name}
                  {state.presets.some((p) => p.provider === provider.id && p.enabled) && (
                    <Badge variant="secondary" className="ml-2 text-[10px]">in use</Badge>
                  )}
                </Label>
                <input
                  id={`key-${provider.id}`}
                  type="password"
                  placeholder={provider.placeholder}
                  value={keys[provider.id] ?? ""}
                  onChange={(e) => setKeys((prev) => ({ ...prev, [provider.id]: e.target.value }))}
                  className="w-full bg-background border border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary transition-all font-mono"
                />
              </div>
            ))}
          </div>

          {/* Active Presets */}
          {state.presets.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Available Presets
              </h4>
              <div className="grid gap-1.5">
                {state.presets.map((preset) => (
                  <div key={preset.id} className="flex items-center justify-between text-xs border border-border px-3 py-2">
                    <span className="font-medium">{preset.name}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">{preset.provider}/{preset.model}</span>
                      {preset.isDefault && <Badge variant="outline" className="text-[10px]">default</Badge>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <Button onClick={handleSave} className="w-full rounded-none uppercase tracking-widest text-xs">
            {saved ? (
              <span className="flex items-center gap-2"><Check className="w-3.5 h-3.5" /> Saved</span>
            ) : (
              t("common.save", "Save")
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
