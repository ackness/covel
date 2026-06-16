import {
  MapPin,
  Users,
  Zap,
  Clock,
  Coins,
  Building2,
  Palette,
  Gamepad2,
  Flag,
} from "lucide-react";
import type {
  WorldGeography,
  WorldFaction,
  WorldPowerSystem,
  WorldHistoryEvent,
  WorldEconomy,
  WorldSocialStructure,
  WorldTone,
  WorldMechanics,
  WorldStartingConditions,
} from "@covel/shared";
import { Badge } from "@/components/ui/badge.js";
import { WorldDimensionSection } from "../world-dimension-section.js";
import {
  text,
  DetailCard,
  DetailCardTitle,
  BadgeList,
  type DetailTranslate,
} from "./detail-primitives.js";

export function GeographySection({
  geo,
  t,
}: {
  geo: WorldGeography;
  t: DetailTranslate;
}) {
  return (
    <WorldDimensionSection title={t("world.geography")} icon={MapPin}>
      {geo.overview && (
        <p className="mb-3 text-sm text-muted-foreground">
          {text(geo.overview)}
        </p>
      )}
      <div className="space-y-2">
        {geo.regions.map((region, i) => (
          <DetailCard
            key={i}
            title={<DetailCardTitle>{text(region.name)}</DetailCardTitle>}
          >
            <p>{text(region.description)}</p>
            {region.climate && (
              <Badge variant="outline" className="mt-1">
                {text(region.climate)}
              </Badge>
            )}
            {region.landmarks && region.landmarks.length > 0 && (
              <ul className="mt-2 list-disc pl-4">
                {region.landmarks.map((lm, j) => (
                  <li key={j}>
                    {text(lm.name)}
                    {lm.description ? ` — ${text(lm.description)}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </DetailCard>
        ))}
      </div>
    </WorldDimensionSection>
  );
}

export function FactionsSection({
  factions,
  t,
}: {
  factions: readonly WorldFaction[];
  t: DetailTranslate;
}) {
  return (
    <WorldDimensionSection title={t("world.factions")} icon={Users}>
      <div className="space-y-2">
        {factions.map((faction) => (
          <DetailCard
            key={faction.id}
            title={
              <div className="flex items-center gap-2">
                <DetailCardTitle>{text(faction.name)}</DetailCardTitle>
                <Badge variant="secondary" className="text-xs">
                  {faction.type}
                </Badge>
                <Badge variant="outline" className="text-xs">
                  {faction.influence}
                </Badge>
              </div>
            }
            contentClassName="space-y-1 p-3 pt-1 text-xs text-muted-foreground"
          >
            <p>{text(faction.description)}</p>
            {faction.leader && (
              <p>
                <span className="font-medium">{t("world.leader")}:</span>{" "}
                {text(faction.leader)}
              </p>
            )}
            {faction.headquarters && (
              <p>
                <span className="font-medium">{t("world.headquarters")}:</span>{" "}
                {text(faction.headquarters)}
              </p>
            )}
            {faction.relations && faction.relations.length > 0 && (
              <ul className="mt-1 list-disc pl-4">
                {faction.relations.map((rel, j) => (
                  <li key={j}>
                    <Badge variant="outline" className="mr-1 text-xs">
                      {rel.type}
                    </Badge>
                    {rel.targetId}
                    {rel.description ? ` — ${text(rel.description)}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </DetailCard>
        ))}
      </div>
    </WorldDimensionSection>
  );
}

export function PowerSystemSection({
  ps,
  t,
}: {
  ps: WorldPowerSystem;
  t: DetailTranslate;
}) {
  return (
    <WorldDimensionSection title={t("world.powerSystem")} icon={Zap}>
      <div className="space-y-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="font-medium">{text(ps.name)}</span>
          <Badge variant="secondary">{ps.type}</Badge>
        </div>
        <p className="text-muted-foreground">{text(ps.description)}</p>
        {ps.rules.length > 0 && (
          <ul className="list-disc pl-4 text-xs text-muted-foreground">
            {ps.rules.map((rule, i) => (
              <li key={i}>{text(rule)}</li>
            ))}
          </ul>
        )}
        {ps.tiers && ps.tiers.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {[...ps.tiers]
              .sort((a, b) => a.rank - b.rank)
              .map((tier, i) => (
                <Badge key={i} variant="outline" className="text-xs">
                  {tier.rank}. {text(tier.name)}
                </Badge>
              ))}
          </div>
        )}
      </div>
    </WorldDimensionSection>
  );
}

export function HistorySection({
  events,
  t,
}: {
  events: readonly WorldHistoryEvent[];
  t: DetailTranslate;
}) {
  const sorted = [...events].sort((a, b) => {
    if (a.era !== b.era) return text(a.era).localeCompare(text(b.era));
    return text(a.year).localeCompare(text(b.year));
  });
  return (
    <WorldDimensionSection title={t("world.history")} icon={Clock}>
      <div className="space-y-2">
        {sorted.map((evt, i) => (
          <div key={i} className="flex gap-2 text-xs">
            <span className="shrink-0 font-medium">
              {[text(evt.era), text(evt.year)].filter(Boolean).join(" ")}
            </span>
            <div className="border-l border-border pl-2">
              <span className="font-medium">{text(evt.name)}</span>{" "}
              <Badge
                variant={evt.significance === "major" ? "default" : "outline"}
                className="text-xs"
              >
                {evt.significance}
              </Badge>
              <p className="text-muted-foreground">{text(evt.description)}</p>
            </div>
          </div>
        ))}
      </div>
    </WorldDimensionSection>
  );
}

export function EconomySection({
  economy,
  t,
}: {
  economy: WorldEconomy;
  t: DetailTranslate;
}) {
  return (
    <WorldDimensionSection title={t("world.economy")} icon={Coins}>
      <div className="space-y-2 text-sm">
        {economy.currencies.length > 0 && (
          <ul className="list-disc pl-4 text-xs text-muted-foreground">
            {economy.currencies.map((cur, i) => (
              <li key={i}>
                <span className="font-medium">{text(cur.name)}</span>
                {cur.symbol ? ` (${cur.symbol})` : ""}
                {cur.description ? ` — ${text(cur.description)}` : ""}
              </li>
            ))}
          </ul>
        )}
        {economy.resources && economy.resources.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium">{t("world.resources")}</p>
            <BadgeList items={economy.resources} />
          </div>
        )}
        {economy.tradeNotes && (
          <p className="text-xs text-muted-foreground">
            {text(economy.tradeNotes)}
          </p>
        )}
      </div>
    </WorldDimensionSection>
  );
}

export function SocialSection({
  social,
  t,
}: {
  social: WorldSocialStructure;
  t: DetailTranslate;
}) {
  return (
    <WorldDimensionSection title={t("world.socialStructure")} icon={Building2}>
      <div className="space-y-3 text-sm">
        {social.classes && social.classes.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium">{t("world.classes")}</p>
            <ul className="list-disc pl-4 text-xs text-muted-foreground">
              {social.classes.map((cls, i) => (
                <li key={i}>
                  <span className="font-medium">{text(cls.name)}</span>
                  {cls.description ? ` — ${text(cls.description)}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
        {social.races && social.races.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium">{t("world.races")}</p>
            {social.races.map((race, i) => (
              <div key={i} className="mb-1 text-xs">
                <span className="font-medium">{text(race.name)}</span>
                {race.description && (
                  <span className="text-muted-foreground">
                    {" "}
                    — {text(race.description)}
                  </span>
                )}
                {race.traits && race.traits.length > 0 && (
                  <BadgeList items={race.traits} className="mt-0.5" />
                )}
              </div>
            ))}
          </div>
        )}
        {social.notes && (
          <p className="text-xs text-muted-foreground">{text(social.notes)}</p>
        )}
      </div>
    </WorldDimensionSection>
  );
}

export function ToneSection({
  tone,
  t,
}: {
  tone: WorldTone;
  t: DetailTranslate;
}) {
  return (
    <WorldDimensionSection title={t("world.tone")} icon={Palette}>
      <div className="space-y-2 text-sm">
        <div className="flex flex-wrap gap-1">
          {tone.genres.map((g, i) => (
            <Badge key={i} variant="secondary" className="text-xs">
              {g}
            </Badge>
          ))}
          <Badge variant="default" className="text-xs">
            {tone.contentRating}
          </Badge>
        </div>
        {tone.narrativeStyle && (
          <p className="text-xs text-muted-foreground">
            {text(tone.narrativeStyle)}
          </p>
        )}
        {tone.themes && tone.themes.length > 0 && (
          <BadgeList items={tone.themes} />
        )}
      </div>
    </WorldDimensionSection>
  );
}

export function MechanicsSection({
  mechanics,
  t,
}: {
  mechanics: WorldMechanics;
  t: DetailTranslate;
}) {
  return (
    <WorldDimensionSection title={t("world.mechanics")} icon={Gamepad2}>
      <div className="space-y-2 text-sm">
        <div className="flex flex-wrap gap-1">
          {mechanics.combatStyle && (
            <Badge variant="secondary" className="text-xs">
              {mechanics.combatStyle}
            </Badge>
          )}
          {mechanics.difficulty && (
            <Badge variant="outline" className="text-xs">
              {mechanics.difficulty}
            </Badge>
          )}
        </div>
        {mechanics.skillSystem && (
          <p className="text-xs text-muted-foreground">
            {text(mechanics.skillSystem)}
          </p>
        )}
        {mechanics.customRules && mechanics.customRules.length > 0 && (
          <ul className="list-disc pl-4 text-xs text-muted-foreground">
            {mechanics.customRules.map((rule, i) => (
              <li key={i}>{text(rule)}</li>
            ))}
          </ul>
        )}
      </div>
    </WorldDimensionSection>
  );
}

export function StartingSection({
  sc,
  t,
}: {
  sc: WorldStartingConditions;
  t: DetailTranslate;
}) {
  return (
    <WorldDimensionSection title={t("world.startingConditions")} icon={Flag}>
      <div className="space-y-2 text-sm">
        <p className="text-muted-foreground">{text(sc.openingScenario)}</p>
        {sc.startingLocation && (
          <p className="text-xs">
            <span className="font-medium">{t("world.startingLocation")}:</span>{" "}
            {text(sc.startingLocation)}
          </p>
        )}
        {sc.playerConstraints && sc.playerConstraints.length > 0 && (
          <ul className="list-disc pl-4 text-xs text-muted-foreground">
            {sc.playerConstraints.map((c, i) => (
              <li key={i}>{text(c)}</li>
            ))}
          </ul>
        )}
        {sc.startingResources &&
          Object.keys(sc.startingResources).length > 0 && (
            <div className="flex flex-wrap gap-1">
              {Object.entries(sc.startingResources).map(([name, amount]) => (
                <Badge key={name} variant="outline" className="text-xs">
                  {name}: {amount}
                </Badge>
              ))}
            </div>
          )}
      </div>
    </WorldDimensionSection>
  );
}
