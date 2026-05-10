import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ComponentRenderer } from "@json-render/react";
import { clsx } from "clsx";
import * as Icons from "lucide-react";
import {
  formatDateTime,
  isRecordLike,
  toTextArray,
  useI18nResolver,
} from "./helpers.js";

export { CharacterFieldsView } from "./character-fields-renderer.js";

// ── CharacterBlueprintList ───────────────────────────────────────

interface CharacterBlueprintRecordView {
  readonly key: string;
  readonly blueprint: {
    readonly id?: string;
    readonly name?: string;
    readonly role?: string;
    readonly description?: string;
    readonly source?: string;
    readonly aliases?: readonly unknown[];
    readonly tags?: readonly unknown[];
    readonly attributes?: Record<string, unknown>;
    readonly persona?: {
      readonly summary?: string;
      readonly traits?: readonly unknown[];
      readonly goals?: readonly unknown[];
      readonly voice?: string;
      readonly style?: string;
    };
  };
  readonly importedAt?: string;
  readonly sourceWorldId?: string;
  readonly instantiatedCharacterId?: string;
}

function readBlueprintEntries(value: unknown): CharacterBlueprintRecordView[] {
  const entries = Array.isArray(value) ? value : [];
  return entries
    .map((entry, index): CharacterBlueprintRecordView | null => {
      if (!isRecordLike(entry)) return null;
      const rawValue = entry.value;
      if (!isRecordLike(rawValue) || !isRecordLike(rawValue.blueprint)) {
        return null;
      }
      const blueprint =
        rawValue.blueprint as CharacterBlueprintRecordView["blueprint"];
      return {
        key:
          typeof entry.key === "string"
            ? entry.key
            : (blueprint.id ?? `blueprint-${index}`),
        blueprint,
        importedAt:
          typeof rawValue.importedAt === "string"
            ? rawValue.importedAt
            : undefined,
        sourceWorldId:
          typeof rawValue.sourceWorldId === "string"
            ? rawValue.sourceWorldId
            : undefined,
        instantiatedCharacterId:
          typeof rawValue.instantiatedCharacterId === "string"
            ? rawValue.instantiatedCharacterId
            : undefined,
      };
    })
    .filter((entry): entry is CharacterBlueprintRecordView => entry !== null);
}

function BlueprintChip({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "primary" | "success" | "info";
}) {
  return (
    <span
      className={clsx(
        "ui-chip inline-flex max-w-full items-center px-1.5 py-0.5 text-[9px] leading-none border",
        tone === "primary" &&
          "border-[var(--accent-primary)]/30 bg-[color-mix(in_oklab,var(--accent-primary)_10%,transparent)] text-[var(--accent-primary)]",
        tone === "success" &&
          "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
        tone === "info" &&
          "border-sky-500/25 bg-sky-500/10 text-sky-600 dark:text-sky-300",
        tone === "muted" && "border-border bg-muted text-muted-foreground",
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

export const CharacterBlueprintList: ComponentRenderer = ({ element }) => {
  const { t } = useTranslation();
  const records = readBlueprintEntries(element.props?.value);
  if (records.length === 0) {
    return (
      <div className="ui-band-quiet px-2 py-3 text-center text-[11px] text-muted-foreground">
        {t("characterBlueprint.empty", "No blueprints imported")}
      </div>
    );
  }

  return (
    <div className="ui-frame divide-y divide-border/50 overflow-hidden">
      {records.map((record) => {
        const blueprint = record.blueprint;
        const name = blueprint.name ?? blueprint.id ?? record.key;
        const role = blueprint.role ?? "npc";
        const tags = toTextArray(blueprint.tags);
        const aliases = toTextArray(blueprint.aliases);
        const persona = blueprint.persona ?? {};
        const attributes = isRecordLike(blueprint.attributes)
          ? Object.entries(blueprint.attributes).slice(0, 4)
          : [];
        const instantiated = Boolean(record.instantiatedCharacterId);
        const roleLabel = t(`character.type.${role}`, role);

        return (
          <div
            key={record.key}
            className="px-3 py-2.5 space-y-2 bg-background/20"
          >
            <div className="flex items-center justify-between gap-2 min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <Icons.IdCard className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold leading-tight text-foreground">
                    {name}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <BlueprintChip tone="primary">{roleLabel}</BlueprintChip>
                    {instantiated && (
                      <BlueprintChip tone="success">
                        {t(
                          "characterBlueprint.instantiated",
                          "Character linked",
                        )}
                      </BlueprintChip>
                    )}
                    {record.sourceWorldId && (
                      <BlueprintChip tone="info">
                        {record.sourceWorldId}
                      </BlueprintChip>
                    )}
                  </div>
                </div>
              </div>
              {record.importedAt && (
                <div className="shrink-0 text-[9px] tabular-nums text-muted-foreground">
                  {formatDateTime(record.importedAt)}
                </div>
              )}
            </div>

            {(blueprint.description || persona.summary) && (
              <p className="line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
                {persona.summary ?? blueprint.description}
              </p>
            )}

            {(tags.length > 0 || aliases.length > 0) && (
              <div className="flex flex-wrap gap-1">
                {aliases.slice(0, 2).map((alias) => (
                  <BlueprintChip key={`alias-${alias}`}>{alias}</BlueprintChip>
                ))}
                {tags.slice(0, 4).map((tag) => (
                  <BlueprintChip key={`tag-${tag}`} tone="info">
                    {tag}
                  </BlueprintChip>
                ))}
              </div>
            )}

            {attributes.length > 0 && (
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-dashed border-border/50 pt-2">
                {attributes.map(([key, value]) => (
                  <div
                    key={key}
                    className="min-w-0 truncate text-[10px] leading-snug"
                  >
                    <span className="font-mono text-muted-foreground">
                      {key}
                    </span>
                    <span className="text-muted-foreground/60">: </span>
                    <span className="text-foreground/85">
                      {typeof value === "object"
                        ? JSON.stringify(value)
                        : String(value)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="text-[9px] text-muted-foreground truncate">
              {record.instantiatedCharacterId ??
                t("characterBlueprint.blueprintOnly", "Blueprint only")}
            </div>
          </div>
        );
      })}
    </div>
  );
};

// ── SceneCastList ────────────────────────────────────────────────

interface SceneCastSpeakerView {
  readonly id?: string;
  readonly name?: string;
  readonly type?: string;
  readonly description?: string;
  readonly score?: number;
  readonly signals?: readonly unknown[];
  readonly signalViews?: readonly {
    readonly id?: string;
    readonly label?: unknown;
  }[];
}

function readSceneCastSpeakers(value: unknown): SceneCastSpeakerView[] {
  return Array.isArray(value)
    ? value.filter(isRecordLike).map((speaker) => ({
        id: typeof speaker.id === "string" ? speaker.id : undefined,
        name: typeof speaker.name === "string" ? speaker.name : undefined,
        type: typeof speaker.type === "string" ? speaker.type : undefined,
        description:
          typeof speaker.description === "string"
            ? speaker.description
            : undefined,
        score: typeof speaker.score === "number" ? speaker.score : undefined,
        signals: Array.isArray(speaker.signals) ? speaker.signals : [],
        signalViews: Array.isArray(speaker.signalViews)
          ? speaker.signalViews.filter(isRecordLike).map((signal) => ({
              id: typeof signal.id === "string" ? signal.id : undefined,
              label: signal.label,
            }))
          : [],
      }))
    : [];
}

function compactSpeakerId(value: string | undefined): string {
  if (!value) return "";
  const npcIndex = value.lastIndexOf("-npc-");
  if (npcIndex >= 0) return value.slice(npcIndex + 1);
  const playerIndex = value.lastIndexOf("-player-");
  if (playerIndex >= 0) return value.slice(playerIndex + 1);
  if (value.length <= 28) return value;
  return value.slice(-28);
}

export const SceneCastList: ComponentRenderer = ({ element }) => {
  const { t } = useTranslation();
  const resolve = useI18nResolver();
  const speakers = readSceneCastSpeakers(element.props?.speakers);
  const reason =
    typeof element.props?.reason === "string" ? element.props.reason : "";
  const reasonLabel = resolve(element.props?.reasonLabel);

  if (speakers.length === 0) {
    return (
      <div className="ui-band-quiet px-3 py-4 text-[11px] leading-relaxed text-muted-foreground">
        {reasonLabel || reason || t("common.noData", "No data")}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {speakers.map((speaker, index) => {
        const name =
          (speaker.name ?? compactSpeakerId(speaker.id)) || `#${index + 1}`;
        const compactId = compactSpeakerId(speaker.id);
        const signals =
          speaker.signalViews && speaker.signalViews.length > 0
            ? speaker.signalViews
            : (speaker.signals ?? []).map((signal) => ({ label: signal }));
        return (
          <div
            key={speaker.id ?? `${name}-${index}`}
            className="ui-band space-y-2"
            data-tone="muted"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex min-w-0 items-center gap-2">
                  <Icons.UserRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate text-[13px] font-semibold text-foreground">
                    {name}
                  </span>
                  {speaker.type && (
                    <BlueprintChip tone="primary">
                      {t(`character.type.${speaker.type}`, speaker.type)}
                    </BlueprintChip>
                  )}
                </div>
                {compactId && (
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {compactId}
                  </div>
                )}
              </div>
              {typeof speaker.score === "number" && (
                <div className="shrink-0 rounded-[var(--radius-control)] border border-border bg-muted px-2 py-1 text-center">
                  <div className="font-mono text-[13px] text-foreground">
                    {speaker.score}
                  </div>
                </div>
              )}
            </div>

            {speaker.description && (
              <p className="line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
                {speaker.description}
              </p>
            )}

            {signals.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {signals.map((signal, signalIndex) => (
                  <BlueprintChip key={`${speaker.id ?? index}-${signalIndex}`}>
                    {resolve(signal.label)}
                  </BlueprintChip>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {reason && (
        <div className="text-[10px] leading-relaxed text-muted-foreground">
          {reason}
        </div>
      )}
    </div>
  );
};
