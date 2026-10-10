import {
  WORLD_LORE_TOKEN_BUDGET,
  fitWorldLore,
  localizedWorldText,
  playerVisibleLore,
} from "@covel/shared";
import { useTranslation } from "react-i18next";
import type { CSSProperties } from "react";
import { ArrowLeft, Trash2 } from "lucide-react";
import type { WorldRecord } from "@/services/api.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Separator } from "@/components/ui/separator.js";
import { text } from "./world-detail/detail-primitives.js";
import {
  worldLanguageBadge,
  worldLanguageName,
  worldPlayLocale,
} from "@/lib/world-locale.js";
import { worldVisual } from "@/lib/world-visuals.js";
import { worldPackageInfo } from "@/lib/package-info.js";
import { PackageCredits } from "@/components/shared/package-credits.js";
import { DimensionValueView } from "@/components/session/dimension-value-view.js";
import { MusicSwitch } from "@/components/session/session-music.js";
import { WorldGallerySection } from "./world-gallery.js";
import { useWorldThemeMusic } from "./world-music.js";
import { WorldRevisePanel, isWorldRevisable } from "./world-revise-panel.js";
import {
  WorldTranslatePanel,
  isWorldTranslatable,
} from "./world-translate-panel.js";
export interface WorldDetailViewProps {
  world: WorldRecord;
  onClose: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  /** The world was changed here; the caller keeps the new record. */
  onRevised?: (world: WorldRecord) => void;
}

export function WorldDetailView({
  world,
  onClose,
  onEdit,
  onDelete,
  onRevised,
}: WorldDetailViewProps) {
  const { t, i18n } = useTranslation();
  const dims = world.dimensions;
  const interfaceLocale = i18n.resolvedLanguage ?? i18n.language;
  // The language this player would play the world in.
  const playLocale = worldPlayLocale(world, interfaceLocale);
  const languageBadge = worldLanguageBadge(playLocale);
  const languageName = worldLanguageName(playLocale, interfaceLocale);
  // The name and summary of that edition, not always the world's own language.
  const shown = localizedWorldText(
    {
      name: text(world.name),
      description: text(world.description),
      lore: text(world.lore),
      locale: world.locale,
      metadata: world.metadata,
    },
    playLocale,
  );
  const visual = worldVisual(world);
  const lore = playerVisibleLore(shown.lore ?? "").trim();
  // The model reads the narrator-only parts too, so the whole text counts.
  const fitted = fitWorldLore(shown.lore ?? "");
  const hasThemeMusic = useWorldThemeMusic(world);

  const hasDimensions =
    dims &&
    Object.values(dims).some((v) =>
      Array.isArray(v) ? v.length > 0 : v != null,
    );

  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-5 sm:px-6 md:px-8 md:py-8">
        <header
          className="relative min-h-64 overflow-hidden rounded-(--radius-card) border border-border bg-card"
          style={{ "--world-accent": visual.accent } as CSSProperties}
        >
          <img
            src={visual.image}
            alt=""
            aria-hidden="true"
            width={1536}
            height={1024}
            loading="eager"
            className="absolute inset-0 h-full w-full object-cover"
            draggable={false}
          />
          <div className="absolute inset-0 bg-linear-to-r from-black/85 via-black/62 to-black/24" />
          <div className="relative z-10 flex min-h-64 flex-col justify-between gap-8 p-5 text-white sm:p-7">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={onClose}
                aria-label={t("world.backToList")}
                className="h-10 border border-white/18 bg-black/28 px-3 text-white hover:bg-white/12 hover:text-white"
              >
                <ArrowLeft className="h-4 w-4" />
                <span>{t("world.backToList")}</span>
              </Button>
              <div className="flex-1" />
              {hasThemeMusic && (
                <MusicSwitch
                  className="ui-btn h-10 w-10 border border-white/25 bg-black/24 p-0 text-white hover:bg-white/12"
                  t={t}
                />
              )}
              {languageBadge && languageName && (
                <Badge
                  variant="outline"
                  className="border-white/25 bg-black/24 text-white"
                  title={t("world.languageLabel", {
                    language: languageName,
                    defaultValue: "World language: {{language}}",
                  })}
                >
                  {languageBadge}
                </Badge>
              )}
              {onEdit && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-10 border-white/25 bg-black/24 text-white hover:bg-white/12 hover:text-white"
                  onClick={onEdit}
                >
                  {t("common.edit")}
                </Button>
              )}
              {onDelete && (
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-10"
                  onClick={onDelete}
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  {t("world.delete", "Delete world")}
                </Button>
              )}
            </div>
            <div className="max-w-3xl space-y-4">
              <h1 className="ui-title text-3xl leading-none text-white sm:text-5xl">
                {shown.name}
              </h1>
              {world.tags && world.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {world.tags.map((tag) => (
                    <Badge
                      key={tag}
                      variant="secondary"
                      className="border-white/15 bg-white/12 text-xs text-white"
                    >
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Description */}
        {world.description && (
          <p className="max-w-3xl text-base leading-relaxed text-muted-foreground wrap-break-word">
            {shown.description}
          </p>
        )}

        <PackageCredits
          info={worldPackageInfo(world)}
          packageName={shown.name ?? world.id}
          className="max-w-3xl text-sm"
        />

        {fitted.truncated && (
          <p
            role="note"
            className="max-w-3xl rounded border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
          >
            {t("world.loreTooLong", {
              tokens: fitted.tokens,
              budget: WORLD_LORE_TOKEN_BUDGET,
            })}
          </p>
        )}

        <WorldGallerySection
          world={world}
          title={shown.name ?? text(world.name)}
          t={t}
        />

        {onRevised && isWorldTranslatable(world, interfaceLocale) && (
          <WorldTranslatePanel
            world={world}
            locale={interfaceLocale}
            onTranslated={onRevised}
          />
        )}
        {onRevised && isWorldRevisable(world) && (
          <WorldRevisePanel world={world} onRevised={onRevised} />
        )}

        <Separator />

        {/* Dimensions */}
        {hasDimensions && dims ? (
          <div className="space-y-4">
            {Object.entries(dims).map(([id, definition]) => (
              <section key={id} className="space-y-2 rounded border p-4">
                <h2 className="font-medium">
                  {text(definition.name)}{" "}
                  <span className="text-xs text-muted-foreground">{id}</span>
                </h2>
                {definition.description && (
                  <p className="text-sm text-muted-foreground">
                    {text(definition.description)}
                  </p>
                )}
                <DimensionValueView
                  schema={definition.schema}
                  value={definition.initialValue}
                />
              </section>
            ))}
          </div>
        ) : (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>{t("world.noStructuredData")}</p>
            {lore && (
              <div className="whitespace-pre-wrap rounded border border-border p-3 text-xs">
                {lore}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
