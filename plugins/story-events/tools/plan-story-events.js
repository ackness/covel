// Turns the planner's flat `all` / `none` lists into a story-events condition
// tree and checks every reference against this execution's inputs, so the
// model gets a correctable error instead of a plan that intake will reject
// or an event that can never fire.

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
const NUMERIC_OPERATORS = ["gte", "gt", "lte", "lt"];
const SINCE_BOUNDS = ["turnsSinceGte", "turnsSinceLte"];
// What a condition is about. A condition has exactly one of them.
const KINDS = ["dimension", "time", "revealed", "afterTurns"];
const CONDITION_KEYS = new Set([
  ...KINDS,
  "path",
  ...SINCE_BOUNDS,
  ...OPERATORS,
]);
const EVENT_KEYS = new Set([
  "id",
  "title",
  "all",
  "none",
  "payload",
  "priority",
]);
const MAX_AFTER_TURNS = 50;

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function slotValue(context, name) {
  const slot = context.inputSlots?.[name];
  return slot && "value" in slot ? slot.value : undefined;
}

/** The first of `id-2`, `id-3`, … that no event has, within the ID limit. */
function nextEventId(id, taken) {
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const next = `${id.slice(0, 64 - suffix.length)}${suffix}`;
    if (!taken.has(next)) return next;
  }
}

/** "a, b, c", or what to do when there is nothing to choose from. */
function choices(values, none) {
  const list = [...values];
  return list.length ? list.slice(0, 16).join(", ") : none;
}

/** A field written as `null` is a field left out. */
function withoutNulls(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== null),
  );
}

/**
 * Put one list of conditions into the declared shape where the meaning is
 * not in doubt. Each of these came back in real-model runs and cost a
 * rejected call:
 * - `{ "turnsSinceGte": 2 }` as an entry of its own, after the `revealed`
 *   condition it belongs to;
 * - `notExists` for the opposite of `exists`;
 * - `"operator": "gte", "value": 3` for `"gte": 3`.
 */
function normalizeConditions(list) {
  if (!Array.isArray(list)) return list;
  const conditions = [];
  for (const entry of list) {
    if (!isRecord(entry)) {
      conditions.push(entry);
      continue;
    }
    const condition = withoutNulls(entry);
    if (
      typeof condition.notExists === "boolean" &&
      condition.exists === undefined
    ) {
      condition.exists = !condition.notExists;
      delete condition.notExists;
    }
    if (
      OPERATORS.includes(condition.operator) &&
      condition[condition.operator] === undefined &&
      (condition.value !== undefined || condition.operator === "exists")
    ) {
      condition[condition.operator] = condition.value ?? true;
      delete condition.operator;
      delete condition.value;
    }
    const keys = Object.keys(condition);
    const previous = conditions.at(-1);
    if (
      keys.length &&
      keys.every((key) => SINCE_BOUNDS.includes(key)) &&
      isRecord(previous) &&
      previous.revealed !== undefined &&
      keys.every((key) => previous[key] === undefined)
    ) {
      Object.assign(previous, condition);
      continue;
    }
    conditions.push(condition);
  }
  return conditions;
}

/**
 * Put an event into the declared shape where the meaning is not in doubt:
 * - a condition written on the event, beside `all`, is one more `all`
 *   condition;
 * - `{ "none": [...] }` as an entry of `all` is the event's `none`;
 * - a `description` beside the `payload` is left out: a planned event has no
 *   such field, and the payload says what happens;
 * - a field that is no field of an event and holds an empty text is left
 *   out: the model wrote a place for a note and put nothing there.
 */
function normalizeEvent(event) {
  if (!isRecord(event)) return event;
  const { description, ...rest } = Object.fromEntries(
    Object.entries(withoutNulls(event)).filter(
      ([key, value]) =>
        value !== "" || EVENT_KEYS.has(key) || CONDITION_KEYS.has(key),
    ),
  );
  const normalized =
    description !== undefined &&
    !(typeof rest.payload === "string" && rest.payload.trim())
      ? { ...rest, description }
      : rest;
  if (KINDS.some((key) => normalized[key] !== undefined)) {
    const condition = {};
    for (const key of Object.keys(normalized)) {
      if (!CONDITION_KEYS.has(key)) continue;
      condition[key] = normalized[key];
      delete normalized[key];
    }
    normalized.all = [
      ...(Array.isArray(normalized.all) ? normalized.all : []),
      condition,
    ];
  }
  if (Array.isArray(normalized.all)) {
    const nested = normalized.all.filter(
      (entry) =>
        isRecord(entry) &&
        Object.keys(entry).length === 1 &&
        Array.isArray(entry.none),
    );
    if (nested.length) {
      normalized.all = normalized.all.filter(
        (entry) => !nested.includes(entry),
      );
      normalized.none = [
        ...(Array.isArray(normalized.none) ? normalized.none : []),
        ...nested.flatMap((entry) => entry.none),
      ];
    }
  }
  for (const key of ["all", "none"])
    if (normalized[key] !== undefined)
      normalized[key] = normalizeConditions(normalized[key]);
  return normalized;
}

function normalizeArguments(input) {
  if (!isRecord(input) || !Array.isArray(input.events)) return input;
  // A text among the events is what is left of a broken end: in recorded
  // calls `"reason ="` or `"reason:"` after the last event. It is no event,
  // and it is left out when the call holds an event to keep.
  const events = input.events.some(isRecord)
    ? input.events.filter((event) => typeof event !== "string")
    : input.events;
  return { ...input, events: events.map(normalizeEvent) };
}

const typesOf = (node) =>
  node?.type === undefined
    ? []
    : Array.isArray(node.type)
      ? node.type
      : [node.type];
const isNumberNode = (node) =>
  typesOf(node).some((type) => type === "number" || type === "integer");

// Returned by `schemaAt` when the schema has no such path.
const NO_SUCH_PATH = Symbol("no such path");

/**
 * The schema node a dot path leads to. `NO_SUCH_PATH` when the schema rules
 * the path out; undefined when the schema does not say.
 */
function schemaAt(schema, path) {
  let node = schema;
  for (const segment of (path ?? "").split(".").filter(Boolean)) {
    if (!isRecord(node)) return undefined;
    if (isRecord(node.properties) && Object.hasOwn(node.properties, segment))
      node = node.properties[segment];
    else if (isRecord(node.items) && /^\d+$/.test(segment)) node = node.items;
    else if (isRecord(node.additionalProperties))
      node = node.additionalProperties;
    else if (node.additionalProperties === false) return NO_SUCH_PATH;
    else return undefined;
  }
  return isRecord(node) ? node : undefined;
}

function fieldNote(path, node) {
  if (Array.isArray(node.enum))
    return `${path} (${node.enum.slice(0, 8).join(" | ")})`;
  const types = typesOf(node).filter((type) => type !== "null");
  return types.length ? `${path} (${types.join(" | ")})` : path;
}

/**
 * The fields of a dimension that a condition can test, as text for an error:
 * numbers, booleans, and strings, two levels deep. `<key>` stands for the
 * keys of a map.
 */
function testableFields(schema, onlyNumbers = false) {
  const notes = [];
  const visit = (node, path, depth) => {
    if (!isRecord(node) || notes.length >= 12) return;
    const types = typesOf(node);
    if (types.includes("object") || isRecord(node.properties)) {
      if (depth >= 2) return;
      for (const [key, child] of Object.entries(node.properties ?? {}))
        visit(child, path ? `${path}.${key}` : key, depth + 1);
      if (isRecord(node.additionalProperties))
        visit(
          node.additionalProperties,
          path ? `${path}.<key>` : "<key>",
          depth + 1,
        );
      return;
    }
    if (types.includes("array") || !path) return;
    if (!onlyNumbers || isNumberNode(node)) notes.push(fieldNote(path, node));
  };
  visit(schema, "", 0);
  return notes;
}

/** Why a dimension condition can never hold, and how to write it. */
function dimensionIssues(condition, operator, entry) {
  const where = `${condition.dimension}${condition.path ? `.${condition.path}` : ""}`;
  const fields = () =>
    choices(testableFields(entry.schema), "see its schema in dimensions.value");
  const node = schemaAt(entry.schema, condition.path);
  if (node === NO_SUCH_PATH)
    return [
      `${where}: the dimension has no such field. Its fields: ${fields()}`,
    ];
  if (!node) return [];
  const types = typesOf(node);
  if (
    operator !== "exists" &&
    (types.includes("object") || types.includes("array"))
  )
    return [
      `${where} is ${types.join(" | ")}, not one value: \`${operator}\` can never hold. Set \`path\` to one of its fields: ${fields()}`,
    ];
  if (
    NUMERIC_OPERATORS.includes(operator) &&
    types.length &&
    !isNumberNode(node)
  )
    return [
      `${where} is ${types.join(" | ")}: \`${operator}\` needs a number. Number fields of ${condition.dimension}: ${choices(testableFields(entry.schema, true), "none; use equals or in")}`,
    ];
  if (Array.isArray(node.enum)) {
    const wanted =
      operator === "equals"
        ? [condition.equals]
        : operator === "in"
          ? condition.in
          : [];
    const unknown = wanted.filter((value) => !node.enum.includes(value));
    if (wanted.length && unknown.length === wanted.length)
      return [
        `${where} is never ${unknown.map((value) => JSON.stringify(value)).join(" or ")}. Its values: ${node.enum.join(", ")}`,
      ];
  }
  return [];
}

/**
 * Settle a dimension ID and a path that run into each other. The model
 * writes the path where the ID goes (`dimension: "map.hall.status"`), or
 * starts the path with the ID (`dimension: "alarm", path: "alarm.level"`).
 * When the text before the first dot is a dimension, the rest is the path;
 * a written `path` follows it unless the rest ends with it already. A
 * reading that the dimension's schema rules out is not taken.
 */
function withSplitDimension(condition, dimensions) {
  const { dimension, path: written } = condition;
  if (typeof dimension !== "string") return condition;
  const ruledOut = (id, path) =>
    schemaAt(dimensions.get(id).schema, path) === NO_SUCH_PATH;
  if (dimensions.has(dimension)) {
    const prefix = `${dimension}.`;
    if (typeof written !== "string" || !written.startsWith(prefix))
      return condition;
    const path = written.slice(prefix.length);
    return ruledOut(dimension, written) && !ruledOut(dimension, path)
      ? { ...condition, path }
      : condition;
  }
  const dot = dimension.indexOf(".");
  const id = dimension.slice(0, dot);
  if (dot < 1 || !dimensions.has(id)) return condition;
  const rest = dimension.slice(dot + 1);
  const tail =
    typeof written === "string" && written.startsWith(`${id}.`)
      ? written.slice(id.length + 1)
      : written;
  const path =
    tail === undefined || rest === tail || rest.endsWith(`.${tail}`)
      ? rest
      : `${rest}.${tail}`;
  return ruledOut(id, path) ? condition : { ...condition, dimension: id, path };
}

/**
 * A number comparison on a dimension that is an object with one number
 * field means that field: `{ dimension: "alarm", gte: 3 }` for
 * `alarm.level`. With two number fields the path is not known.
 */
function withOnlyNumberField(condition, operator, entry) {
  if (condition.path !== undefined || !NUMERIC_OPERATORS.includes(operator))
    return condition;
  const properties = entry.schema?.properties;
  if (!isRecord(properties)) return condition;
  const numbers = Object.keys(properties).filter((key) =>
    isNumberNode(properties[key]),
  );
  return numbers.length === 1 ? { ...condition, path: numbers[0] } : condition;
}

/**
 * Check one condition and turn it into a leaf of the stored condition tree.
 * Returns `{ leaf }`, or `{ issues }` that name what the model can use
 * instead: with "unknown event: x" alone it guessed another name, was
 * rejected again, and then added the missing event as a third one, which
 * the limit of two rejected as well.
 */
function settle(written, refs) {
  let condition = withSplitDimension(written, refs.dimensions);
  // `worldTime` stands beside the dimensions in the inputs, and the model
  // names it as the dimension of a world-time condition: with the field
  // under `time`, or under `path`.
  if (
    condition.dimension !== undefined &&
    !refs.dimensions.has(condition.dimension)
  ) {
    const { dimension, path, ...rest } = condition;
    if (path === undefined && refs.timeFields.has(condition.time))
      condition = rest;
    else if (
      dimension === "worldTime" &&
      condition.time === undefined &&
      refs.timeFields.has(path)
    )
      condition = { time: path, ...rest };
  }
  const kinds = KINDS.filter((key) => condition[key] !== undefined);
  if (kinds.length !== 1)
    return {
      issues: [
        kinds.includes("dimension") && kinds.includes("time")
          ? `a condition has \`dimension\` or \`time\`, not both; this one has ${condition.dimension} and ${condition.time}. A world-time condition is { "time", operator }. A dimension condition is { "dimension", "path", operator }`
          : `a condition has exactly one of dimension, time, revealed, afterTurns; this one has ${kinds.length ? kinds.join(" and ") : "none"}. Write one condition for each`,
      ],
    };
  const [kind] = kinds;
  const operators = OPERATORS.filter((key) => condition[key] !== undefined);
  const bounds = SINCE_BOUNDS.filter((key) => condition[key] !== undefined);

  if (kind === "afterTurns") {
    if (operators.length || bounds.length || condition.path !== undefined)
      return {
        issues: ["an `afterTurns` condition has no other field"],
      };
    return { leaf: { turnGte: refs.turn + condition.afterTurns } };
  }
  if (kind === "revealed") {
    if (operators.length || condition.path !== undefined)
      return {
        issues: [
          `a \`revealed\` condition takes turnsSinceGte / turnsSinceLte only; this one has ${[...operators, ...(condition.path === undefined ? [] : ["path"])].join(" and ")}`,
        ],
      };
    if (!refs.eventIds.has(condition.revealed))
      return {
        issues: [
          `unknown event: ${condition.revealed}. \`revealed\` takes the ID of a story event in storyEvents.value (${choices(refs.knownEventIds, "none yet")}) or of an event in this call. Something that happened in the narrative is not a story event. Use one of these IDs, or remove the condition; to make the event come later, use { "afterTurns": n }`,
        ],
      };
    return { leaf: condition };
  }
  if (bounds.length)
    return {
      issues: [
        `${bounds.join(" and ")} belongs to a \`revealed\` condition, not to a ${kind} condition`,
      ],
    };
  if (operators.length !== 1)
    return {
      issues: [
        `a ${kind} condition has exactly one operator (${OPERATORS.join(", ")}); this one has ${operators.length ? operators.join(" and ") : "none"}. For a range, write two conditions`,
      ],
    };
  const [operator] = operators;
  if (kind === "time") {
    if (condition.path !== undefined)
      return { issues: ["a world-time condition has no `path`"] };
    if (!refs.timeFields.has(condition.time))
      return {
        issues: [
          `unknown time field: ${condition.time}. The numeric fields of worldTime.value are: ${choices(refs.timeFields, "none; use dimension, revealed, or afterTurns")}`,
        ],
      };
    const values =
      operator === "in"
        ? condition.in
        : operator === "exists"
          ? []
          : [condition[operator]];
    if (values.some((value) => typeof value !== "number"))
      return {
        issues: [
          `time field ${condition.time} is a number (now ${refs.time[condition.time]}): compare it with a number`,
        ],
      };
    return { leaf: condition };
  }
  const entry = refs.dimensions.get(condition.dimension);
  if (!entry)
    return {
      issues: [
        `unknown dimension: ${condition.dimension}. The dimensions are: ${choices(refs.dimensions.keys(), "none in this world; use time, revealed, or afterTurns")}`,
      ],
    };
  condition = withOnlyNumberField(condition, operator, entry);
  const issues = dimensionIssues(condition, operator, entry);
  return issues.length ? { issues } : { leaf: condition };
}

function toCondition(all, none) {
  const nodes = [...all];
  if (none.length)
    nodes.push({ not: none.length === 1 ? none[0] : { any: none } });
  return nodes.length === 1 ? nodes[0] : { all: nodes };
}

export default function ({ tool, z }) {
  const id = z.string().regex(EVENT_ID).describe("Lowercase kebab-case ID");
  const scalar = z.union([z.string(), z.number(), z.boolean()]);
  const condition = z
    .object({
      dimension: z
        .string()
        .optional()
        .describe("Form 1. ID of a dimension in dimensions.value"),
      path: z
        .string()
        .optional()
        .describe(
          "Form 1. Dot path to one field of the dimension value, as its schema names it",
        ),
      time: z
        .string()
        .optional()
        .describe(
          "Form 2. Name of a numeric field of worldTime.value. A world has its own fields: read them there. Never together with `dimension`",
        ),
      revealed: id
        .optional()
        .describe(
          "Form 3. ID of a story event: one that storyEvents.value lists, or the `id` of the other event in this call. The condition holds once that event has fired. Something that happened in the narrative is not a story event",
        ),
      turnsSinceGte: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Form 3. The event fired this many turns ago or more"),
      turnsSinceLte: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Form 3. The event fired this many turns ago or fewer"),
      afterTurns: z
        .number()
        .int()
        .min(1)
        .max(MAX_AFTER_TURNS)
        .optional()
        .describe(
          "Form 4, alone. The condition holds from this many turns after this turn. Use it to make an event wait",
        ),
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
    // The model wrote ranges as one condition (`gte` with `lte`), put a
    // dimension on a world-time condition, and named things that happened
    // in the narrative as events: nothing told it what the forms are.
    .describe(
      'One condition, in one of four forms. 1: a dimension field, { "dimension", "path", one operator }. 2: a world-time field, { "time", one operator }. 3: a story event that fired, { "revealed", "turnsSinceGte"? }. 4: a wait, { "afterTurns" }. Operators: `equals`, `notEquals`, `in`, `gte`, `gt`, `lte`, `lt`, `exists`. For a range, write two conditions.',
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
        .array(condition)
        .min(1)
        .max(6)
        .describe("Conditions that must all hold"),
      none: z
        .array(condition)
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
      "Plant up to two hidden follow-up events, or withdraw pending planned events. An event fires once, on the first turn where every `all` condition holds and no `none` condition holds. A condition tests one dimension field, one numeric world-time field, one story event that fired, or a number of turns to wait. Submit an empty events list when nothing should be planned.",
    parameters: z.preprocess(
      normalizeArguments,
      z
        .object({
          events: z.array(event).max(2),
          retire: z
            .array(id)
            .max(4)
            .optional()
            .describe("Pending planned event IDs to withdraw"),
          // One or two sentences. The model does not count characters, so
          // the limit is far from what the description asks for. It is a
          // note for debugging that nothing reads: a plan without it is
          // taken.
          reason: z
            .string()
            .max(600)
            .optional()
            .describe("Why these events, in one or two sentences"),
        })
        .strict(),
    ),
    execute: async (params, context) => {
      const ledger = slotValue(context, "storyEvents");
      if (!ledger || typeof ledger !== "object")
        throw new Error("Story planning requires the storyEvents ledger input");
      const time = slotValue(context, "worldTime") ?? {};
      const known = [...ledger.revealed, ...ledger.planned].map(
        (item) => item.eventId,
      );
      const pending = new Set(ledger.planned.map((item) => item.eventId));
      const refs = {
        dimensions: new Map(
          Object.entries(slotValue(context, "dimensions") ?? {}),
        ),
        time,
        // `schemaVersion` is the version of the world-time contract, not a
        // clock: a condition on it holds always or never.
        timeFields: new Set(
          Object.keys(time).filter(
            (key) => typeof time[key] === "number" && key !== "schemaVersion",
          ),
        ),
        turn: ledger.turn,
        knownEventIds: known,
        eventIds: new Set([...known, ...params.events.map((item) => item.id)]),
      };

      const issues = [];
      for (const retired of params.retire ?? [])
        if (!pending.has(retired))
          issues.push(`${retired}: only pending planned events can be retired`);
      const events = params.events.map((written) => {
        let item = written;
        // An event that fired is never planned again. A model that plans
        // what follows it writes the ID it reads in `revealed`: the plan is
        // a new event, and it gets the next free ID. The model reads that ID
        // in the result and, from the next turn, in `planned`.
        if (known.includes(written.id) && !pending.has(written.id)) {
          item = { ...written, id: nextEventId(written.id, refs.eventIds) };
          refs.eventIds.add(item.id);
        }
        const leaves = { all: [], none: [] };
        for (const key of ["all", "none"])
          for (const written of item[key] ?? []) {
            // "Unless that event has fired", for an event that does not
            // exist: it never fires, so the condition never holds and says
            // nothing. The model writes it for something the narrative may
            // show later. A rejection made it remove the condition, and in
            // one recorded retry it also turned another condition around.
            if (
              key === "none" &&
              typeof written.revealed === "string" &&
              !refs.eventIds.has(written.revealed)
            )
              continue;
            const settled = settle(written, refs);
            if (settled.leaf) leaves[key].push(settled.leaf);
            else
              for (const issue of settled.issues)
                issues.push(`${item.id}: ${issue}`);
          }
        return { item, leaves };
      });
      if (issues.length) throw new Error([...new Set(issues)].join("\n"));

      return {
        events: events.map(({ item, leaves }) => ({
          id: item.id,
          title: item.title,
          when: toCondition(leaves.all, leaves.none),
          payload: item.payload,
          ...(item.priority === undefined ? {} : { priority: item.priority }),
        })),
        ...(params.retire?.length ? { retire: params.retire } : {}),
        ...(params.reason ? { reason: params.reason } : {}),
      };
    },
  });
}
