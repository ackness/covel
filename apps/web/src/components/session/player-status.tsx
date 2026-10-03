import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSession } from "@/stores/session-store.js";
import { resolveDisplayText } from "@/lib/i18n-text.js";

export interface StatusMeter {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
}

export interface StatusReadout {
  readonly id: string;
  readonly label: string;
  readonly value: number;
}

export interface PlayerStatus {
  readonly name: string;
  readonly meters: readonly StatusMeter[];
  /** Numeric stats the world gave no range: shown as a number, not a gauge. */
  readonly readouts: readonly StatusReadout[];
  /** What the player carries, in schema order. */
  readonly items: readonly string[];
}

/** A glance shows a few gauges; the character panel has the full sheet. */
const MAX_METERS = 4;
const MAX_READOUTS = 4;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * The player at a glance, read from the session World Model: the character
 * record plus the session's character schema. Gauges are the bounded `stats`
 * attributes, unbounded ones are plain numbers, and carried items are the
 * string lists in the `equipment` category.
 * Both are kernel data — the world defines which attributes exist — so nothing
 * here depends on a plugin, and a world that declares neither yields nothing.
 */
export function selectPlayerStatus(
  gameState: Readonly<Record<string, unknown>>,
  locale: string,
): PlayerStatus | null {
  const characters = Array.isArray(gameState.characters)
    ? gameState.characters
    : [];
  const player = characters
    .map(asRecord)
    .find((character) => character?.type === "player");
  if (!player) return null;
  const fields = asRecord(player.fields) ?? {};
  const attributes = asRecord(gameState.characterSchema)?.attributes;
  const meters: StatusMeter[] = [];
  const readouts: StatusReadout[] = [];
  const items: string[] = [];
  for (const raw of Array.isArray(attributes) ? attributes : []) {
    const attribute = asRecord(raw);
    if (!attribute || typeof attribute.id !== "string") continue;
    if (attribute.type === "array" && attribute.category === "equipment") {
      const carried = fields[attribute.id];
      for (const item of Array.isArray(carried) ? carried : []) {
        if (typeof item === "string" && item.trim()) items.push(item.trim());
      }
      continue;
    }
    if (attribute.type !== "number" || attribute.category !== "stats") continue;
    const value =
      finite(fields[attribute.id]) ?? finite(attribute.defaultValue);
    if (value === undefined) continue;
    const label = resolveDisplayText(attribute.name, locale) || attribute.id;
    const min = finite(attribute.min);
    const max = finite(attribute.max);
    if (min === undefined || max === undefined || max <= min) {
      if (readouts.length < MAX_READOUTS)
        readouts.push({ id: attribute.id, label, value });
      continue;
    }
    if (meters.length === MAX_METERS) continue;
    meters.push({
      id: attribute.id,
      label,
      value: Math.min(max, Math.max(min, value)),
      min,
      max,
    });
  }
  if (meters.length === 0 && readouts.length === 0 && items.length === 0)
    return null;
  return {
    name: typeof player.name === "string" ? player.name : "",
    meters,
    readouts,
    items,
  };
}

export function usePlayerStatus(): PlayerStatus | null {
  const { state } = useSession();
  const { i18n } = useTranslation();
  return useMemo(
    () => selectPlayerStatus(state.gameState, i18n.language),
    [state.gameState, i18n.language],
  );
}

/** Gauges only; the caller owns the surrounding surface and heading. */
export function PlayerStatusMeters({
  status,
  layout,
}: {
  readonly status: PlayerStatus;
  /** `columns` sits gauges side by side; `rows` stacks label · bar · value. */
  readonly layout: "columns" | "rows";
}) {
  if (status.meters.length === 0) return null;
  if (layout === "rows") {
    return (
      <div className="ui-status-meters grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-2 text-xs">
        {status.meters.map((meter) => (
          <MeterRow key={meter.id} meter={meter} />
        ))}
      </div>
    );
  }
  return (
    <div
      className="ui-status-meters grid gap-4"
      style={{
        gridTemplateColumns: `repeat(${status.meters.length}, minmax(0, 1fr))`,
      }}
    >
      {status.meters.map((meter) => (
        <div key={meter.id} className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-xs text-muted-foreground">
              {meter.label}
            </span>
            <span className="ui-status-value shrink-0 text-sm font-semibold tabular-nums">
              {meter.value}
              <span className="text-[11px] font-normal text-muted-foreground">
                {" "}
                / {meter.max}
              </span>
            </span>
          </div>
          <MeterBar meter={meter} />
        </div>
      ))}
    </div>
  );
}

/** Carried items as chips; past `max`, the rest collapse into a count. */
export function PlayerItems({
  items,
  max,
}: {
  readonly items: readonly string[];
  readonly max: number;
}) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  return (
    <ul
      aria-label={t("session.playerItems")}
      className="ui-status-items flex flex-wrap gap-1.5"
    >
      {items.slice(0, max).map((item, index) => (
        // Items are free text and may repeat, so position is the identity.
        <li key={`${index}:${item}`} className="ui-status-item">
          {item}
        </li>
      ))}
      {items.length > max && (
        <li className="ui-status-item">+{items.length - max}</li>
      )}
    </ul>
  );
}

function MeterRow({ meter }: { readonly meter: StatusMeter }) {
  return (
    <>
      <span className="text-muted-foreground">{meter.label}</span>
      <MeterBar meter={meter} />
      <span className="text-right tabular-nums">
        {meter.value} / {meter.max}
      </span>
    </>
  );
}

export function MeterBar({
  meter,
}: {
  readonly meter: Omit<StatusMeter, "id">;
}) {
  const ratio = (meter.value - meter.min) / (meter.max - meter.min);
  return (
    <div
      role="meter"
      aria-label={meter.label}
      aria-valuemin={meter.min}
      aria-valuemax={meter.max}
      aria-valuenow={meter.value}
      className="ui-meter-track h-1 overflow-hidden rounded-full"
    >
      <div
        className="ui-meter-fill h-full rounded-full"
        style={{ width: `${Math.round(ratio * 100)}%` }}
      />
    </div>
  );
}
