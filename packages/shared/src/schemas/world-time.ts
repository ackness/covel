import { z } from "zod";

const text = z.union([z.string().min(1), z.record(z.string(), z.string())]);
const positive = z.number().int().min(1).max(1_000_000);
const evolution = z
  .object({
    mode: z.enum(["forward", "backward", "bidirectional", "random"]),
    defaultStep: z.number().int().min(0).max(1_000_000),
    maxStep: positive,
    randomRange: z
      .object({
        min: z.number().int().min(-1_000_000).max(1_000_000),
        max: z.number().int().min(-1_000_000).max(1_000_000),
      })
      .strict()
      .optional(),
    prompt: text.optional(),
  })
  .strict();

/** World-owned time data. Evolution and formatting belong to the provider plugin. */
export const worldTimeSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("calendar"),
        name: text,
        calendar: z
          .object({
            era: text,
            months: z
              .array(z.object({ name: text, days: positive }).strict())
              .min(1)
              .max(100),
            hoursPerDay: positive,
            minutesPerHour: positive,
            weekdays: z.array(text).min(1).max(100).optional(),
            periods: z
              .array(
                z
                  .object({ name: text, startHour: z.number().int().min(0) })
                  .strict(),
              )
              .max(100)
              .optional(),
          })
          .strict(),
        initial: z
          .object({
            year: z.number().int().min(-1_000_000).max(1_000_000),
            month: positive,
            day: positive,
            hour: z.number().int().min(0),
            minute: z.number().int().min(0),
            weekday: z.number().int().min(0).optional(),
          })
          .strict(),
        evolution,
      })
      .strict(),
    z
      .object({
        kind: z.literal("phases"),
        name: text,
        phases: z.array(text).min(1).max(100),
        cycleLabel: text,
        initial: z
          .object({
            cycle: z.number().int().min(-1_000_000).max(1_000_000),
            phase: z.number().int().min(0),
          })
          .strict(),
        evolution,
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const rule = value.evolution;
    if (rule.defaultStep > rule.maxStep)
      issue(["evolution", "defaultStep"], "defaultStep exceeds maxStep");
    if (rule.mode === "random" && !rule.randomRange)
      issue(
        ["evolution", "randomRange"],
        "random mode requires a signed range in base units",
      );
    if (
      rule.randomRange &&
      (rule.randomRange.min > rule.randomRange.max ||
        Math.max(
          Math.abs(rule.randomRange.min),
          Math.abs(rule.randomRange.max),
        ) > rule.maxStep)
    ) {
      issue(
        ["evolution", "randomRange"],
        "range must be ordered and within maxStep",
      );
    }
    if (value.kind === "phases") {
      if (value.initial.phase >= value.phases.length)
        issue(["initial", "phase"], "phase index is outside phases");
      return;
    }
    const { calendar, initial } = value;
    if (
      calendar.weekdays &&
      (initial.weekday === undefined ||
        initial.weekday >= calendar.weekdays.length)
    ) {
      issue(
        ["initial", "weekday"],
        "calendar weekdays require a valid initial weekday index",
      );
    } else if (!calendar.weekdays && initial.weekday !== undefined) {
      issue(["initial", "weekday"], "weekday requires calendar.weekdays");
    }
    const month = calendar.months[initial.month - 1];
    if (!month) issue(["initial", "month"], "month is outside calendar");
    else if (initial.day > month.days)
      issue(["initial", "day"], "day is outside month");
    if (initial.hour >= calendar.hoursPerDay)
      issue(["initial", "hour"], "hour is outside day");
    if (initial.minute >= calendar.minutesPerHour)
      issue(["initial", "minute"], "minute is outside hour");
    let previous = -1;
    for (const [index, period] of (calendar.periods ?? []).entries()) {
      if (
        period.startHour <= previous ||
        period.startHour >= calendar.hoursPerDay
      )
        issue(
          ["calendar", "periods", index],
          "period starts must be increasing and within the day",
        );
      previous = period.startHour;
    }
    const yearTicks =
      calendar.months.reduce((sum, item) => sum + item.days, 0) *
      calendar.hoursPerDay *
      calendar.minutesPerHour;
    if (
      !Number.isSafeInteger(yearTicks) ||
      !Number.isSafeInteger((Math.abs(initial.year) + 2) * yearTicks)
    )
      issue(["calendar"], "calendar exceeds safe integer arithmetic");
  });

export type WorldTimeDefinition = z.infer<typeof worldTimeSchema>;
