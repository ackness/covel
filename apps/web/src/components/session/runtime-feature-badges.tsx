import {
  BookOpen,
  Clock,
  Cpu,
  Database,
  Hand,
  Image,
  Puzzle,
  Radio,
  Shield,
  Timer,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { FrameworkCapability, FrameworkRuntimeCapability } from "@covel/shared";
import { Badge } from "@/components/ui/badge.js";

export interface RuntimeFeatureMetadata {
  readonly kind?: string;
  readonly runtimeType?: string;
  readonly trigger?: { readonly type?: string };
  readonly outputKind?: string;
  readonly capabilities?: readonly string[];
  readonly turnCompletion?: { readonly mode?: string };
  readonly execution?: string;
}

type RuntimeFeatureKind =
  | "background"
  | "agent"
  | "function"
  | "automatic"
  | "scheduled"
  | "manual"
  | "event"
  | "narrative"
  | "media"
  | "data"
  | "system"
  | "auxiliary";

export interface RuntimeFeature {
  readonly kind: RuntimeFeatureKind;
  readonly labelKey: string;
  readonly titleKey: string;
  readonly icon: LucideIcon;
  readonly tone: "neutral" | "blue" | "amber" | "violet" | "emerald";
}

const MEDIA_CAPABILITIES = new Set<string>([
  FrameworkCapability.ImageGeneration,
  FrameworkRuntimeCapability.ImagePrompt,
  FrameworkRuntimeCapability.ImageGenerator,
  "tts",
  "narrative-audio",
]);

const DATA_CAPABILITIES = new Set<string>([
  FrameworkCapability.WorldDataProvider,
  FrameworkCapability.MemoryPanel,
  "world-ir-provider",
]);

function triggerFeature(
  triggerType: string | undefined,
): RuntimeFeature | undefined {
  switch (triggerType) {
    case "manual":
      return feature("manual", "Hand", "amber");
    case "event":
      return feature("event", "Radio", "violet");
    case "scheduled":
      return feature("scheduled", "Timer", "neutral");
    case "auto":
    case undefined:
      return feature("automatic", "Zap", "neutral");
    default:
      return undefined;
  }
}

const ICONS = {
  BookOpen,
  Clock,
  Cpu,
  Database,
  Hand,
  Image,
  Puzzle,
  Radio,
  Shield,
  Timer,
  Wrench,
  Zap,
} as const;

function feature(
  kind: RuntimeFeatureKind,
  icon: keyof typeof ICONS,
  tone: RuntimeFeature["tone"],
): RuntimeFeature {
  return {
    kind,
    labelKey: `plugin.runtimeFeature.${kind}`,
    titleKey: `plugin.runtimeFeature.${kind}Title`,
    icon: ICONS[icon],
    tone,
  };
}

function outputFeature(
  runtime: RuntimeFeatureMetadata,
): RuntimeFeature | undefined {
  const capabilities = new Set(runtime.capabilities ?? []);
  if ([...capabilities].some((item) => MEDIA_CAPABILITIES.has(item))) {
    return feature("media", "Image", "violet");
  }
  if ([...capabilities].some((item) => DATA_CAPABILITIES.has(item))) {
    return feature("data", "Database", "emerald");
  }
  if (
    runtime.outputKind === "story" ||
    capabilities.has(FrameworkCapability.Narrative)
  ) {
    return feature("narrative", "BookOpen", "blue");
  }
  if (runtime.outputKind === "system") {
    return feature("system", "Shield", "neutral");
  }
  return runtime.outputKind === "plugin"
    ? feature("auxiliary", "Puzzle", "neutral")
    : undefined;
}

/** Derive only features backed by manifest/discovery fields. */
export function deriveRuntimeFeatures(
  runtime: RuntimeFeatureMetadata,
): readonly RuntimeFeature[] {
  const runtimeType = runtime.runtimeType ?? runtime.kind ?? "agent";
  const trigger = triggerFeature(runtime.trigger?.type);
  const output = outputFeature(runtime);
  return [
    ...(runtime.turnCompletion?.mode === "detached" ||
    runtime.execution === "background"
      ? [feature("background", "Clock", "blue")]
      : []),
    runtimeType === "function"
      ? feature("function", "Wrench", "emerald")
      : feature("agent", "Cpu", "blue"),
    ...(trigger ? [trigger] : []),
    ...(output ? [output] : []),
  ];
}

const TONE_CLASSES: Record<RuntimeFeature["tone"], string> = {
  neutral: "border-border/70 bg-muted/30 text-muted-foreground",
  blue: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  amber:
    "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  violet:
    "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  emerald:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
};

function FeatureBadge({ feature: item }: { feature: RuntimeFeature }) {
  const { t } = useTranslation();
  const Icon = item.icon;
  const title = t(item.titleKey);
  return (
    <Badge
      variant="outline"
      className={`ui-chip h-4 max-w-full shrink-0 gap-0.5 px-1.5 text-[9px] font-medium ${TONE_CLASSES[item.tone]}`}
      title={title}
      aria-label={title}
    >
      <Icon className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{t(item.labelKey)}</span>
    </Badge>
  );
}

export function RuntimeFeatureBadges({
  runtime,
  className = "",
  display = "all",
}: {
  readonly runtime: RuntimeFeatureMetadata;
  readonly className?: string;
  readonly display?: "all" | "summary";
}) {
  const features = deriveRuntimeFeatures(runtime).filter(
    (item) =>
      display === "all" ||
      item.kind === "background" ||
      item.kind === "agent" ||
      item.kind === "function",
  );
  return (
    <span className={`inline-flex min-w-0 flex-wrap gap-1 ${className}`}>
      {features.map((item) => (
        <FeatureBadge key={item.kind} feature={item} />
      ))}
    </span>
  );
}

/** Aggregate multiple runtimes without implying that one marker names them all. */
export function RuntimeCollectionFeatureBadges({
  runtimes,
  className = "",
  display = "all",
}: {
  readonly runtimes: readonly RuntimeFeatureMetadata[];
  readonly className?: string;
  readonly display?: "all" | "summary";
}) {
  const features = new Map<RuntimeFeatureKind, RuntimeFeature>();
  for (const runtime of runtimes) {
    for (const item of deriveRuntimeFeatures(runtime)) {
      features.set(item.kind, item);
    }
  }
  const visibleFeatures = [...features.values()].filter(
    (item) =>
      display === "all" ||
      item.kind === "background" ||
      item.kind === "agent" ||
      item.kind === "function",
  );
  return (
    <span className={`inline-flex min-w-0 flex-wrap gap-1 ${className}`}>
      {visibleFeatures.map((item) => (
        <FeatureBadge key={item.kind} feature={item} />
      ))}
    </span>
  );
}
