import { useCallback, useState } from "react";
import { Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button.js";
import * as api from "@/services/api.js";
import type { PrepSectionStatus } from "./types.js";

interface DimensionImportButtonProps {
  worldId: string;
}

export function DimensionImportButton({ worldId }: DimensionImportButtonProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<PrepSectionStatus>("idle");
  const [message, setMessage] = useState("");

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      setStatus("loading");
      setMessage("");

      try {
        const fileText = await file.text();

        let dimensions: Record<string, unknown>;
        if (file.name.endsWith(".json")) {
          dimensions = JSON.parse(fileText) as Record<string, unknown>;
        } else {
          const { parse } = await import("yaml");
          dimensions = parse(fileText) as Record<string, unknown>;
        }

        await api.importDimensions(worldId, dimensions);
        setStatus("success");
        setMessage(t("session.dimensionsImported"));
      } catch (err) {
        setStatus("error");
        setMessage(err instanceof Error ? err.message : String(err));
      }

      event.target.value = "";
    },
    [worldId, t],
  );

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs gap-1.5 relative"
        disabled={status === "loading"}
        asChild
      >
        <label>
          <Upload className="w-3 h-3" />
          {t("session.importDimensions")}
          <input
            type="file"
            accept=".yaml,.yml,.json"
            className="sr-only"
            onChange={handleFileSelect}
          />
        </label>
      </Button>
      {message && (
        <span
          className={`text-[10px] ${status === "error" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {message}
        </span>
      )}
    </div>
  );
}
