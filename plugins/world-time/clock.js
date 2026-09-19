import { resolveI18nText, worldTimeSchema } from "@covel/shared";

export const DEFAULT_TIME = worldTimeSchema.parse({
  kind: "calendar",
  name: { zh: "世界时间", en: "World time" },
  calendar: {
    era: { zh: "世界历", en: "World era" },
    months: Array.from({ length: 12 }, (_, index) => ({
      name: { zh: `${index + 1}月`, en: `Month ${index + 1}` },
      days: 30,
    })),
    hoursPerDay: 24,
    minutesPerHour: 60,
    periods: [
      { startHour: 0, name: { zh: "深夜", en: "Night" } },
      { startHour: 6, name: { zh: "早晨", en: "Morning" } },
      { startHour: 12, name: { zh: "下午", en: "Afternoon" } },
      { startHour: 18, name: { zh: "夜晚", en: "Evening" } },
    ],
  },
  initial: { year: 1, month: 1, day: 1, hour: 8, minute: 0 },
  evolution: { mode: "forward", defaultStep: 10, maxStep: 525600 },
});

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
    const unit =
      request.unit ?? (definition.kind === "calendar" ? "minute" : "phase");
    if (!Object.hasOwn(units, unit))
      throw new Error(
        `Unit ${unit} is not available for ${definition.kind} time`,
      );
    const direction =
      request.direction ?? (rule.mode === "backward" ? "backward" : "forward");
    if (!["forward", "backward"].includes(direction))
      throw new Error("Invalid time direction");
    if (rule.mode !== "bidirectional" && direction !== rule.mode)
      throw new Error(`Time policy only permits ${rule.mode} movement`);
    delta = safe(amount * units[unit]) * (direction === "backward" ? -1 : 1);
  }
  if (Math.abs(delta) > rule.maxStep)
    throw new Error(`Time change exceeds maxStep (${rule.maxStep} base units)`);
  return { tick: safe(tick + delta), delta };
}

export async function loadTime(store, sessionId, pluginId, locale) {
  const stored = await store.getPluginData(
    sessionId,
    pluginId,
    "clock",
    "current",
  );
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
      locale,
    };
  }
  const session = await store.getSession(sessionId);
  const world = session?.worldId ? await store.getWorld(session.worldId) : null;
  const declared = world?.metadata?.dimensions?.time ?? world?.dimensions?.time;
  const definition = worldTimeSchema.parse(declared ?? DEFAULT_TIME);
  const tick = initialTick(definition);
  return {
    schemaVersion: 1,
    definition,
    tick,
    ...describeTime(definition, tick, locale),
    locale,
  };
}
