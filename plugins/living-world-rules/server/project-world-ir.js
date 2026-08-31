const RULE_KINDS = new Set(["constant", "triggered", "evolving"]);
const RULE_CATEGORIES = new Set([
  "character",
  "scene",
  "relationship",
  "world",
  "style",
]);
const BUDGET_CLASSES = new Set(["sticky", "flexible", "droppable"]);
const COORDINATE_POSITIONS = new Set([
  "before_plugin",
  "after_plugin",
  "at_depth",
]);

function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function optionalEnum(value, allowed) {
  return typeof value === "string" && allowed.has(value) ? value : undefined;
}

function optionalStringArray(value) {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (entry) => typeof entry === "string" && entry.length > 0,
  );
  return strings.length > 0 ? strings : undefined;
}

function projectCoordinate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const position = optionalEnum(value.position, COORDINATE_POSITIONS);
  const depth = optionalNumber(value.depth);
  if (position === undefined && depth === undefined) return undefined;
  return {
    ...(position !== undefined ? { position } : {}),
    ...(depth !== undefined ? { depth } : {}),
  };
}

/**
 * Project plugin-neutral WorldIR statements into living-world-rules records.
 * Unknown attributes stay in the IR and are intentionally ignored here.
 */
export default function projectWorldIR({ value }) {
  const rules = value.statements
    .filter((statement) => statement.type === "rule")
    .map((statement) => {
      const attributes = statement.attributes ?? {};
      const title = optionalString(attributes.title);
      const kind = optionalEnum(attributes.kind, RULE_KINDS);
      const category = optionalEnum(attributes.category, RULE_CATEGORIES);
      const coordinate = projectCoordinate(attributes.coordinate);
      const budgetClass = optionalEnum(attributes.budgetClass, BUDGET_CLASSES);
      const keys = optionalStringArray(attributes.keys);
      const insertionOrder = optionalNumber(attributes.insertionOrder);

      return {
        schemaVersion: 1,
        id: statement.id,
        content: statement.content,
        ...(title !== undefined ? { title } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(typeof attributes.enabled === "boolean"
          ? { enabled: attributes.enabled }
          : {}),
        ...(coordinate !== undefined ? { coordinate } : {}),
        ...(budgetClass !== undefined ? { budgetClass } : {}),
        ...(keys !== undefined ? { keys } : {}),
        ...(insertionOrder !== undefined ? { insertionOrder } : {}),
      };
    });

  return { rules };
}
