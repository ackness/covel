/**
 * Read this turn's quest signals from WorldIR.
 *
 * The bundled extractor writes quest signals as `quest_change` events whose
 * attributes carry the quest name, a status (`accepted` / `progressed` /
 * `completed` / `failed`), new objectives and the objectives finished this
 * turn. A new quest is created only from an explicit `accepted` signal; other
 * signals must resolve to a quest already in the log, so a paraphrased name
 * never invents a second quest.
 */

/** Most updates one log call takes; the handler reports the overflow. */
export const MAX_QUESTS = 5;
const STATUS = {
  accepted: undefined,
  progressed: undefined,
  completed: "completed",
  failed: "failed",
};

function normalize(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

/**
 * Resolve a name against the log: exact (normalized) match first, then a
 * unique containment match either way.
 *
 * @param {string} name
 * @param {readonly string[]} known
 * @returns {string | undefined}
 */
export function resolveQuestName(name, known) {
  const target = normalize(name);
  if (!target) return undefined;
  const exact = known.find((candidate) => normalize(candidate) === target);
  if (exact) return exact;
  const contained = known.filter((candidate) => {
    const key = normalize(candidate);
    return key.length >= 2 && (key.includes(target) || target.includes(key));
  });
  return contained.length === 1 ? contained[0] : undefined;
}

const strings = (value) =>
  Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim())
    : [];

/**
 * @param {unknown} worldIR  `contract:world-ir@1` value
 * @param {readonly string[]} knownQuestNames  names already in the quest log
 * @returns {Array<{ name: string, description?: string, status?: string, objectives?: Array<{ text: string, done?: boolean }>, giver?: string, reward?: string }>}
 */
export function questUpdatesFromWorldIR(worldIR, knownQuestNames) {
  if (!worldIR || typeof worldIR !== "object") return [];
  const ir = /** @type {Record<string, any>} */ (worldIR);
  // Quests accepted earlier in this turn can be advanced by later events.
  const names = [...knownQuestNames];
  const updates = [];
  for (const event of Array.isArray(ir.events) ? ir.events : []) {
    if (event?.type !== "quest_change") continue;
    const attributes = event.attributes ?? {};
    if (!Object.hasOwn(STATUS, attributes.status)) continue;
    const named =
      typeof attributes.quest === "string" ? attributes.quest.trim() : "";
    if (!named) continue;
    const known = resolveQuestName(named, names);
    if (!known && attributes.status !== "accepted") continue;
    if (!known) names.push(named);

    const objectives = [
      ...strings(attributes.objectives).map((text) => ({ text })),
      ...strings(attributes.completedObjectives).map((text) => ({
        text,
        done: true,
      })),
    ];
    const update = { name: known ?? named };
    const status = STATUS[attributes.status];
    if (status) update.status = status;
    if (!known && typeof event.description === "string")
      update.description = event.description;
    if (objectives.length) update.objectives = objectives;
    if (typeof attributes.giver === "string") update.giver = attributes.giver;
    if (typeof attributes.reward === "string")
      update.reward = attributes.reward;
    updates.push(update);
  }
  return updates;
}
