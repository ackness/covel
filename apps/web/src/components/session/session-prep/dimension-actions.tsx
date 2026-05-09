import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button.js";
import * as api from "@/services/api.js";
import { DimensionImportButton } from "./dimension-import-button.js";

interface DimensionActionsProps {
  worldId: string;
  enabled: boolean;
}

export function DimensionActions({ worldId, enabled }: DimensionActionsProps) {
  const { t } = useTranslation();

  if (!enabled) return null;

  return (
    <div className="flex items-center gap-2 mb-4 px-1">
      <a href={api.exportDimensionsUrl(worldId)} download>
        <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5">
          <Download className="w-3 h-3" />
          {t("session.exportDimensions")}
        </Button>
      </a>
      <DimensionImportButton worldId={worldId} />
    </div>
  );
}
