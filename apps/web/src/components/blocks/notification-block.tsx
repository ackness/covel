import { Badge } from "@/components/ui/badge.js";
import { Info, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import type { BlockRendererProps } from "./block-renderer.js";

type NotificationLevel = "info" | "warning" | "success" | "error";

const LEVEL_CONFIG: Record<NotificationLevel, {
  icon: typeof Info;
  color: string;
  bg: string;
  border: string;
  label: string;
}> = {
  info: {
    icon: Info,
    color: "text-blue-500 dark:text-blue-400",
    bg: "bg-blue-500/5",
    border: "border-l-blue-500",
    label: "Info",
  },
  warning: {
    icon: AlertTriangle,
    color: "text-amber-500 dark:text-amber-400",
    bg: "bg-amber-500/5",
    border: "border-l-amber-500",
    label: "Warning",
  },
  success: {
    icon: CheckCircle2,
    color: "text-green-500 dark:text-green-400",
    bg: "bg-green-500/5",
    border: "border-l-green-500",
    label: "Success",
  },
  error: {
    icon: XCircle,
    color: "text-red-500 dark:text-red-400",
    bg: "bg-red-500/5",
    border: "border-l-red-500",
    label: "Error",
  },
};

export function NotificationBlock({ data }: BlockRendererProps) {
  const level = (data.level as NotificationLevel) ?? "info";
  const title = data.title as string | undefined;
  const content = data.content as string | undefined;
  const source = data.source as string | undefined;

  const config = LEVEL_CONFIG[level] ?? LEVEL_CONFIG.info;
  const Icon = config.icon;

  return (
    <div className={`inline-flex items-start gap-3 border border-border border-l-2 ${config.border} ${config.bg} px-4 py-3 max-w-md animate-in fade-in slide-in-from-top-1 duration-300`}>
      <Icon className={`h-5 w-5 shrink-0 mt-0.5 ${config.color}`} />
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="flex items-center gap-2">
          {title && <span className="text-xs font-medium">{title}</span>}
          <Badge variant="outline" className={`rounded-none text-[9px] py-0 ${config.color}`}>
            {config.label}
          </Badge>
          {source && (
            <span className="text-[10px] text-muted-foreground ml-auto">{source}</span>
          )}
        </div>
        {content && (
          <p className="text-[11px] text-muted-foreground leading-relaxed">{content}</p>
        )}
      </div>
    </div>
  );
}
