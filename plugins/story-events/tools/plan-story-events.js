// Turns the planner's flat `all` / `none` lists into a story-events condition
// tree and checks every reference against this execution's inputs, so the
// model gets a correctable error instead of a plan that intake will reject.

const EVENT_ID = /^[a-z][a-z0-9-]{0,63}$/;
const OPERATORS = [
  "equals",
  "notEquals",
  "in",
  "gte",
  "gt",
  "lte",
  "lt",
  "exists",
];

function slotValue(context, name) {
  const slot = context.inputSlots?.[name];
  return slot && "value" in slot ? slot.value : undefined;
}

/** "a, b, c", or what to do when there is nothing to choose from. */
function choices(values, none) {
  const list = [...values];
  return list.length ? list.slice(0, 16).join(", ") : none;
}

// An error names what the model can use instead. With "unknown event: x"
// alone it guessed another name, was rejected again, and then added the
// missing event as a third one, which the limit of two rejected as well.
function leafIssues(leaf, refs) {
  const kinds = ["dimension", "time", "revealed"].filter(
    (key) => leaf[key] !== undefined,
  );
  if (kinds.length !== 1)
    return [
      `a condition references exactly one of dimension, time, revealed; this one has ${kinds.length ? kinds.join(" and ") : "none"}. Write one condition for each`,
    ];
  const [kind] = kinds;
  if (kind === "revealed")
    return refs.eventIds.has(leaf.revealed)
      ? []
      : [
          `unknown event: ${leaf.revealed}. \`revealed\` takes the ID of an event in storyEvents.value (${choices(refs.knownEventIds, "none yet")}) or of an event in this call. Use one of them or remove the condition`,
        ];
  const operators = OPERATORS.filter((key) => leaf[key] !== undefined);
  if (operators.length !== 1)
    return [
      `a dimension or time condition has exactly one operator; this one has ${operators.length ? operators.join(" and ") : "none"}. For a range, write two conditions`,
    ];
  if (kind === "dimension")
    return refs.dimensions.has(leaf.dimension)
      ? []
      : [
          `unknown dimension: ${leaf.dimension}. The dimensions are: ${choices(refs.dimensions, "none in this world; use time or revealed")}`,
        ];
  return refs.timeFields.has(leaf.time)
    ? []
    : [
        `unknown time field: ${leaf.time}. The numeric fields of worldTime.value are: ${choices(refs.timeFields, "none; use dimension or revealed")}`,
      ];
}

function toCondition(all, none) {
  const nodes = [...all];
  if (none?.length)
    nodes.push({ not: none.length === 1 ? none[0] : { any: none } });
  return nodes.length === 1 ? nodes[0] : { all: nodes };
}

export default function ({ tool, z }) {
  const id = z.string().regex(EVENT_ID).describe("Lowercase kebab-case ID");
  const scalar = z.union([z.string(), z.number(), z.boolean()]);
  const leaf = z
    .object({
      dimension: z.string().optional().describe("Dimension ID"),
      path: z
        .string()
        .optional()
        .describe("Dot path inside the dimension value"),
      time: z
        .string()
        .optional()
        .describe(
          "Name of a numeric field of worldTime.value. A world has its own fields: read them there",
        ),
      revealed: id
        .optional()
        .describe(
          "ID of an event in storyEvents.value or in this call; the condition holds once that event has fired",
        ),
      turnsSinceGte: z.number().int().min(0).optional(),
      turnsSinceLte: z.number().int().min(0).optional(),
      equals: scalar.optional(),
      notEquals: scalar.optional(),
      in: z.array(scalar).min(1).optional(),
      gte: z.number().optional(),
      gt: z.number().optional(),
      lte: z.number().optional(),
      lt: z.number().optional(),
      exists: z.boolean().optional(),
    })
    .strict()
    // The model wrote ranges as one condition (`gte` with `lte`) and the
    // tool rejected them: nothing told it that the rule exists.
    .describe(
      "One condition. It names one of `dimension` (with `path`), `time`, or `revealed`. A `dimension` or `time` condition has exactly one operator: `equals`, `notEquals`, `in`, `gte`, `gt`, `lte`, `lt`, or `exists`. For a range, write two conditions.",
    );
  const event = z
    .object({
      id,
      title: z
        .string()
        .min(1)
        .max(80)
        .describe("Short public name, shown only after the event fires"),
      all: z
        .array(leaf)
        .min(1)
        .max(6)
        .describe("Conditions that must all hold"),
      none: z
        .array(leaf)
        .max(4)
        .optional()
        .describe("Conditions that must not hold"),
      payload: z
        .string()
        .min(1)
        .max(1200)
        .describe("A brief for the narrator, not finished prose"),
      priority: z.number().int().min(-10).max(10).optional(),
    })
    .strict();

  return tool({
    name: "plan-story-events",
    description:
      "Plant up to two hidden follow-up events, or withdraw pending planned events. Each event fires once, when every `all` condition holds and no `none` condition holds. A condition references one dimension (with an operator and optional dot path), one numeric world-time field (with an operator), or one event by `revealed` (optionally with turnsSinceGte / turnsSinceLte). Submit an empty events list when nothing should be planned.",
    parameters: z
      .object({
        events: z.array(event).max(2),
        retire: z
          .array(id)
          .max(4)
          .optional()
          .describe("Pending planned event IDs to withdraw"),
        // One or two sentences. The model does not count characters, so
        // the limit is far from what the description asks for.
        reason: z
          .string()
          .min(1)
          .max(600)
          .describe("Why these events, in one or two sentences"),
      })
      .strict(),
    execute: async (params, context) => {
      const ledger = slotValue(context, "storyEvents");
      if (!ledger || typeof ledger !== "object")
        throw new Error("Story planning requires the storyEvents ledger input");
      const dimensions = slotValue(context, "dimensions") ?? {};
      const time = slotValue(context, "worldTime") ?? {};
      const known = [...ledger.revealed, ...ledger.planned].map(
        (item) => item.eventId,
      );
      const pending = new Set(ledger.planned.map((item) => item.eventId));
      const refs = {
        dimensions: new Set(Object.keys(dimensions)),
        timeFields: new Set(
          Object.keys(time).filter((key) => typeof time[key] === "number"),
        ),
        knownEventIds: known,
        eventIds: new Set([...known, ...params.events.map((item) => item.id)]),
      };

      const issues = [];
      for (const retired of params.retire ?? [])
        if (!pending.has(retired))
          issues.push(`${retired}: only pending planned events can be retired`);
      for (const item of params.events) {
        if (known.includes(item.id) && !pending.has(item.id))
          issues.push(`${item.id}: this event already fired`);
        for (const condition of [...item.all, ...(item.none ?? [])])
          for (const issue of leafIssues(condition, refs))
            issues.push(`${item.id}: ${issue}`);
      }
      if (issues.length) throw new Error([...new Set(issues)].join("\n"));

      return {
        events: params.events.map((item) => ({
          id: item.id,
          title: item.title,
          when: toCondition(item.all, item.none),
          payload: item.payload,
          ...(item.priority === undefined ? {} : { priority: item.priority }),
        })),
        ...(params.retire?.length ? { retire: params.retire } : {}),
        reason: params.reason,
      };
    },
  });
}
