import { z } from "zod";

/**
 * Fixed attribute shapes for the event types that bundled state plugins read
 * without a model (inventory, core-quest). Other event types keep
 * free-form attributes. Extra attribute keys stay allowed.
 */
const EVENT_PROFILES = {
  inventory_change: z.looseObject({
    item: z.string().min(1),
    holder: z.string().min(1),
    operation: z.enum(["gain", "lose", "equip", "unequip"]),
    quantity: z.number().int().min(1).optional(),
  }),
  quest_change: z.looseObject({
    quest: z.string().min(1),
    status: z.enum(["accepted", "progressed", "completed", "failed"]),
    objectives: z.array(z.string().min(1)).max(8).optional(),
    completedObjectives: z.array(z.string().min(1)).max(8).optional(),
    giver: z.string().min(1).optional(),
    reward: z.string().min(1).optional(),
  }),
};

/**
 * Validate the profiled events of a WorldIR value.
 *
 * @param {{ entities?: ReadonlyArray<{ id: string, type: string }>, events?: ReadonlyArray<{ type: string, attributes?: unknown }> }} facts
 * @returns {Array<{ path: Array<string | number>, message: string }>}
 */
export function eventProfileIssues(facts) {
  const items = new Set(
    (facts.entities ?? [])
      .filter((entity) => entity.type === "item")
      .map((entity) => entity.id),
  );
  const issues = [];
  (facts.events ?? []).forEach((event, index) => {
    if (!Object.hasOwn(EVENT_PROFILES, event.type)) return;
    const profile = EVENT_PROFILES[event.type];
    const parsed = profile.safeParse(event.attributes ?? {});
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        issues.push({
          path: ["events", index, "attributes", ...issue.path],
          message: `${event.type}: ${issue.message}`,
        });
      return;
    }
    if (event.type === "inventory_change" && !items.has(parsed.data.item))
      issues.push({
        path: ["events", index, "attributes", "item"],
        message:
          "inventory_change: item must be the id of an entity with type item in this output",
      });
  });
  return issues;
}
