import { BookOpen, Sparkles, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge.js";
import { cn } from "@/lib/utils.js";
import type { ProvenanceStatus } from "../types.js";

/**
 * Provenance is the core signal of the review UI: where did this entry's
 * content come from. The three states map to the fixed WorldImportDraft
 * contract and must stay visually distinct.
 */

const PROVENANCE_CONFIG: Record<
  ProvenanceStatus,
  {
    icon: typeof BookOpen;
    variant: "secondary" | "outline" | "destructive";
    className: string;
  }
> = {
  "source-backed": {
    icon: BookOpen,
    variant: "secondary",
    className: "text-foreground",
  },
  "ai-inferred": {
    icon: Sparkles,
    variant: "outline",
    className: "border-dashed text-muted-foreground",
  },
  conflict: {
    icon: TriangleAlert,
    variant: "destructive",
    className: "",
  },
};

export function ProvenanceBadge({
  status,
  className,
}: {
  status: ProvenanceStatus;
  className?: string;
}) {
  const { t } = useTranslation();
  const config = PROVENANCE_CONFIG[status];
  const Icon = config.icon;
  return (
    <Badge
      variant={config.variant}
      className={cn("gap-1 font-medium", config.className, className)}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {t(`worldImport.provenance.${status}`)}
    </Badge>
  );
}
