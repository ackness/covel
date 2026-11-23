import {
  Activity,
  AlertTriangle,
  BookOpen,
  Bot,
  CheckCircle2,
  Compass,
  Database,
  FileCode,
  Globe,
  Key,
  Layers,
  LayoutGrid,
  Plug,
  Puzzle,
  RefreshCw,
  Settings,
  Shield,
  Sparkles,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";

const ICON_MAP: Readonly<Record<string, LucideIcon>> = {
  activity: Activity,
  "alert-triangle": AlertTriangle,
  "book-open": BookOpen,
  bot: Bot,
  "check-circle": CheckCircle2,
  compass: Compass,
  database: Database,
  "file-code": FileCode,
  globe: Globe,
  key: Key,
  layers: Layers,
  "layout-grid": LayoutGrid,
  plug: Plug,
  puzzle: Puzzle,
  "refresh-cw": RefreshCw,
  settings: Settings,
  shield: Shield,
  sparkles: Sparkles,
  terminal: Terminal,
  wrench: Wrench,
};

export function resolvePlatformIcon(
  name: string | undefined,
  fallback: LucideIcon = Puzzle,
): LucideIcon {
  if (!name) return fallback;
  const normalized = name.trim().toLowerCase();
  return ICON_MAP[normalized] ?? fallback;
}
