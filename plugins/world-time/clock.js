import { translate } from "@covel/plugin-handlers-utils";
import { resolveI18nText } from "@covel/shared";
import { worldTimeSchema, timeDefinitionRecordSchema } from "./schema.js";

/**
 * The time definition of a world that supplies none, in the language of the
 * session. The definition is stored with the session and given to the
 * narrative, so it holds one language: a table of every language here would
 * put all of them into each prompt.
 */
export function defaultTime(ctx) {
  return worldTimeSchema.parse({
    kind: "calendar",
    name: translate(ctx, "World time"),
    calendar: {
      era: translate(ctx, "World era"),
      months: Array.from({ length: 12 }, (_, index) => ({
        name: translate(ctx, "Month {n}", { n: index + 1 }),
        days: 30,
      })),
      hoursPerDay: 24,
      minutesPerHour: 60,
      periods: [
        { startHour: 0, name: translate(ctx, "Night") },
        { startHour: 6, name: translate(ctx, "Morning") },
        { startHour: 12, name: translate(ctx, "Afternoon") },
        { startHour: 18, name: translate(ctx, "Evening") },
      ],
    },
    initial: { year: 1, month: 1, day: 1, hour: 8, minute: 0 },
    evolution: { mode: "forward", defaultStep: 10, maxStep: 525600 },
  });
}

/** The default definition in English. */
export const DEFAULT_TIME = defaultTime(undefined);

function safe(value) {
  if (!Number.isSafeInteger(value))
    throw new Error("World time exceeds safe integer arithmetic");
  return value;
}

function calendarSizes(definition) {
  const day = safe(
    definition.calendar.hoursPerDay * definition.calendar.minutesPerHour,
  );
  return {
    day,
    year: safe(
      definition.calendar.months.reduce((sum, month) => sum + month.days, 0) *
        day,
    ),
  };
}

export function initialTick(definition) {
  const initial = definition.initial;
  if (definition.kind === "phases")
    return safe(initial.cycle * definition.phases.length + initial.phase);
  const { day, year } = calendarSizes(definition);
  const precedingDays = definition.calendar.months
    .slice(0, initial.month - 1)
    .reduce((sum, month) => sum + month.days, 0);
  return safe(
    (initial.year - 1) * year +
      (precedingDays + initial.day - 1) * day +
      initial.hour * definition.calendar.minutesPerHour +
      initial.minute,
  );
}

/** Floor division keeps negative dates and reverse phase transitions coherent. */
export function describeTime(definition, tick, locale = "en") {
  safe(tick);
  const label = (value) => resolveI18nText(value, locale);
  if (definition.kind === "phases") {
    const cycle = Math.floor(tick / definition.phases.length);
    const phase = tick - cycle * definition.phases.length;
    const period = label(definition.phases[phase]);
    return {
      cycle,
      phase,
      period,
      display: `${label(definition.cycleLabel)} ${cycle} · ${period}`,
    };
  }
  const { day: daySize, year: yearSize } = calendarSizes(definition);
  const yearIndex = Math.floor(tick / yearSize);
  const withinYear = tick - yearIndex * yearSize;
  let dayIndex = Math.floor(withinYear / daySize);
  let monthIndex = 0;
  while (dayIndex >= definition.calendar.months[monthIndex].days) {
    dayIndex -= definition.calendar.months[monthIndex].days;
    monthIndex += 1;
  }
  const withinDay = withinYear % daySize;
  const hour = Math.floor(withinDay / definition.calendar.minutesPerHour);
  const minute = withinDay % definition.calendar.minutesPerHour;
  const periods = definition.calendar.periods ?? [];
  const period =
    [...periods].reverse().find((entry) => entry.startHour <= hour) ??
    periods.at(-1);
  const weekdays = definition.calendar.weekdays;
  const elapsedDays =
    Math.floor(tick / daySize) - Math.floor(initialTick(definition) / daySize);
  const weekdayIndex = weekdays
    ? (((definition.initial.weekday + elapsedDays) % weekdays.length) +
        weekdays.length) %
      weekdays.length
    : undefined;
  const weekday = weekdays ? label(weekdays[weekdayIndex]) : undefined;
  return {
    year: yearIndex + 1,
    month: monthIndex + 1,
    day: dayIndex + 1,
    hour,
    minute,
    ...(weekday ? { weekdayIndex, weekday } : {}),
    ...(period ? { period: label(period.name) } : {}),
    display: `${label(definition.calendar.era)} ${yearIndex + 1} · ${label(definition.calendar.months[monthIndex].name)} ${dayIndex + 1}${weekday ? ` · ${weekday}` : ""} · ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}${period ? ` · ${label(period.name)}` : ""}`,
  };
}

function seededFraction(seed) {
  let hash = 2166136261;
  for (const character of seed)
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0) / 4294967296;
}

/**
 * The units a duration can use on this clock. The first one is the base unit.
 */
export function timeUnits(definition) {
  return definition.kind === "calendar"
    ? ["minute", "hour", "day"]
    : ["phase", "cycle"];
}

/** Tells the caller which units this clock has, not only that one is wrong. */
function unitError(definition, unit) {
  const names = timeUnits(definition).map((name) => `"${name}"`);
  const usable = `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
  return definition.kind === "calendar"
    ? `Unit ${unit} is not available: this world counts time on a calendar. Use unit ${usable}.`
    : `Unit ${unit} is not available: this world counts time in phases, not in minutes or hours. Use unit ${usable}. Use amount 0 when the events stay in the current phase.`;
}

export function advanceTime(definition, tick, request, turnId) {
  const rule = definition.evolution;
  let delta;
  if (rule.mode === "random") {
    if (
      request.amount !== undefined ||
      request.direction !== undefined ||
      request.unit !== undefined
    )
      throw new Error(
        "Random time is sampled by the clock; omit amount, unit and direction",
      );
    const range = rule.randomRange;
    delta =
      range.min +
      Math.floor(seededFraction(turnId) * (range.max - range.min + 1));
  } else {
    if (request.amount === undefined && request.unit !== undefined) {
      throw new Error(
        "Specify amount with unit, or omit both to use defaultStep in base units",
      );
    }
    const amount = request.amount ?? rule.defaultStep;
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new Error("amount must be a non-negative safe integer");
    const units =
      definition.kind === "calendar"
        ? {
            minute: 1,
            hour: definition.calendar.minutesPerHour,
            day: calendarSizes(definition).day,
          }
        : { phase: 1, cycle: definition.phases.length };
    const unit = request.unit ?? timeUnits(definition)[0];
    // Zero is the same duration in every unit.
    if (!Object.hasOwn(units, unit) && amount !== 0)
      throw new Error(unitError(definition, unit));
    const unitSize = Object.hasOwn(units, unit) ? units[unit] : 0;
    const direction =
      request.direction ?? (rule.mode === "backward" ? "backward" : "forward");
    if (!["forward", "backward"].includes(direction))
      throw new Error("Invalid time direction");
    if (rule.mode !== "bidirectional" && direction !== rule.mode)
      throw new Error(`Time policy only permits ${rule.mode} movement`);
    delta = safe(amount * unitSize) * (direction === "backward" ? -1 : 1);
  }
  if (Math.abs(delta) > rule.maxStep)
    throw new Error(`Time change exceeds maxStep (${rule.maxStep} base units)`);
  return { tick: safe(tick + delta), delta };
}

/**
 * The recorded time of the session, or its starting time. `ctx` is the
 * handler context: it gives the messages that name the default calendar.
 */
export async function loadTime(store, locale, ctx) {
  const stored = await store.getPluginData("clock", "current");
  if (stored) {
    const state = stored.value;
    if (
      !state ||
      state.schemaVersion !== 1 ||
      !Number.isSafeInteger(state.tick)
    )
      throw new Error("Invalid stored world time");
    const definition = worldTimeSchema.parse(state.definition);
    return {
      ...state,
      definition,
      ...describeTime(definition, state.tick, locale),
      units: timeUnits(definition),
      locale,
    };
  }
  const imported = await store.getPluginData("definitions", "world");
  const definition = imported
    ? timeDefinitionRecordSchema.parse(imported.value).definition
    : defaultTime(ctx);
  const tick = initialTick(definition);
  return {
    schemaVersion: 1,
    definition,
    tick,
    ...describeTime(definition, tick, locale),
    units: timeUnits(definition),
    locale,
  };
}
