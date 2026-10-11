import { useTranslation } from "react-i18next";
import type { ComponentRenderer } from "@json-render/react";
import { entryListPropsSchema, type StageCastModel } from "@covel/shared";
import { IdCard, UserRound } from "lucide-react";
import { formatDateTime, resolvePath, useI18nResolver } from "./helpers.js";
import { catalogItems } from "./catalog-actions.js";
import { useActiveSessionId } from "./session-context.js";
import { useUiSlot } from "@/stores/ui-slot-store.js";
const text = (value: unknown) =>
  value == null
    ? ""
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
export const EntryList: ComponentRenderer = ({ element }) => {
  const resolve = useI18nResolver();
  const parsed = entryListPropsSchema.safeParse(element.props);
  if (!parsed.success) return null;
  const props = parsed.data;
  const entries = catalogItems(props.items);
  return (
    <div className="ui-frame divide-y divide-border/50 overflow-hidden">
      {entries.map((entry, index) => {
        const title = text(resolvePath(entry, props.titleField));
        const description = props.descriptionFields
          ?.map((field) => resolvePath(entry, field))
          .find(Boolean);
        const badges =
          props.badgeFields?.flatMap((field) => {
            const value = resolvePath(entry, field);
            return Array.isArray(value) ? value : value ? [value] : [];
          }) ?? [];
        const date = props.dateField && resolvePath(entry, props.dateField);
        return (
          <div
            key={text(resolvePath(entry, props.idField)) || String(index)}
            className="px-3 py-2.5 space-y-2 bg-background/20"
          >
            <div className="flex items-center justify-between gap-2 min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <IdCard className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-[13px] font-semibold leading-tight text-foreground">
                  {title}
                </span>
              </div>
              {date ? (
                <span className="text-[9px] text-muted-foreground">
                  {formatDateTime(text(date))}
                </span>
              ) : null}
            </div>
            {description ? (
              <p className="line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
                {text(description)}
              </p>
            ) : null}
            {badges.length ? (
              <div className="flex flex-wrap gap-1">
                {badges.map((badge, i) => (
                  <span
                    key={i}
                    className="ui-chip border border-border bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground"
                  >
                    {text(badge)}
                  </span>
                ))}
              </div>
            ) : null}
            {props.fields?.map((field) => {
              const value = resolvePath(entry, field.path);
              return value == null ? null : (
                <div
                  key={field.path}
                  className="text-[10px] text-muted-foreground"
                >
                  <span>{resolve(field.label) || field.path}: </span>
                  <span>{text(value)}</span>
                </div>
              );
            })}
            {props.footerField ? (
              <div className="text-[9px] text-muted-foreground truncate">
                {text(resolvePath(entry, props.footerField))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

// ── SceneCastList ────────────────────────────────────────────────

export const SceneCastList: ComponentRenderer = () => {
  const { t } = useTranslation();
  const sessionId = useActiveSessionId();
  const cast = useUiSlot(sessionId ?? "", "stage.cast@1")?.value as
    StageCastModel | undefined;
  const speakers = (cast?.actors ?? []).map((actor) => ({
    id: actor.characterId,
    name: actor.displayName,
    type: actor.type,
    description: actor.description,
  }));

  if (speakers.length === 0) {
    return (
      <div className="ui-band-quiet px-3 py-4 text-[11px] leading-relaxed text-muted-foreground">
        {t("sceneCast.empty", "No characters are on stage in this scene yet.")}
      </div>
    );
  }

  // Player-facing "who's in this scene" — name + role only. The internal
  // selection signals / scores / raw character ids stay in plugin_data for the
  // prompt and /debug; the player just sees who is present.
  return (
    <div className="space-y-2">
      {speakers.map((speaker, index) => {
        const name = speaker.name || `#${index + 1}`;
        return (
          <div
            key={speaker.id ?? `${name}-${index}`}
            className="ui-band space-y-1.5"
            data-tone="muted"
          >
            <div className="flex min-w-0 items-center gap-2">
              <UserRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate text-[13px] font-semibold text-foreground">
                {name}
              </span>
              {speaker.type ? (
                <span className="ui-chip px-1.5 py-0.5 text-[9px] border border-border">
                  {t(`character.type.${speaker.type}`, speaker.type)}
                </span>
              ) : null}
            </div>
            {speaker.description ? (
              <p className="line-clamp-2 text-[11px] text-muted-foreground">
                {speaker.description}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};
