/**
 * Plugin-local tool: upsert-quests
 *
 * Batch create or advance quests for the current turn.
 *
 * ### LLM contract
 *
 * The LLM submits quests keyed by canonical **name** (not ID). The tool is
 * responsible for:
 *
 *  1. Loading existing quests from `plugin_data[namespace="quests"]` —
 *     including world-pack preseeded records imported via `dataSchemas`.
 *  2. De-duplicating by normalized name and assigning stable short IDs to
 *     new quests via `shortIdBatch` (e.g. `quest-寻回断魂钩`).
 *  3. Merging updates into existing quests: provided fields override,
 *     objectives are matched by verbatim text (known text updates `done`,
 *     new text appends), omitted `status`/`done` keep their current state
 *     so a partial update can never regress a completed quest or uncheck
 *     a finished objective.
 *  4. Deriving `chips` (a checklist/giver/reward string array) on every
 *     write so the right-panel EntryCard can render objectives without a
 *     framework-side lookup.
 *  5. Writing this turn's change summary (new / progress / completed /
 *     failed) into the `message` namespace for the chat-feed block.
 */

import { makeProposal } from "@covel/plugin-handlers-utils";
import { withPendingProposals } from "@covel/tools";

const MAX_QUESTS_PER_CALL = 5;

// Badge metadata for the message block, keyed by change kind. Stored as
// I18nText so the block resolves it to the session locale at render time.
const CHANGE_META = {
  new: { badge: { zh: "新任务", en: "New" }, color: "blue" },
  progress: { badge: { zh: "推进", en: "Progress" }, color: "cyan" },
  completed: { badge: { zh: "完成", en: "Completed" }, color: "green" },
  failed: { badge: { zh: "失败", en: "Failed" }, color: "red" },
};

export default function ({ tool, z, shortIdBatch, store }) {
  const objectiveSchema = z.object({
    text: z
      .string()
      .min(1)
      .describe(
        "Objective text, matched verbatim against existing objectives — copy existing text exactly when advancing",
      ),
    // Optional on purpose (no zod default): an omitted `done` must stay
    // distinguishable from an explicit `false`, or re-submitting a known
    // objective without it would silently uncheck it on merge.
    done: z
      .boolean()
      .optional()
      .describe(
        "true when the narrative shows this objective accomplished; omit to keep the current state (new objectives default to unchecked)",
      ),
  });

  const questSchema = z.object({
    name: z
      .string()
      .min(1)
      .describe("Canonical quest name (the sole de-duplication/merge key)"),
    description: z
      .string()
      .optional()
      .describe("1-2 factual sentences on the quest's origin and goal"),
    // Same reasoning as `done`: a zod default of "active" would make every
    // partial update regress a completed/failed quest back to active.
    status: z
      .enum(["active", "completed", "failed"])
      .optional()
      .describe(
        "Omit to keep the current status; new quests default to active",
      ),
    objectives: z
      .array(objectiveSchema)
      .optional()
      .describe(
        "Checklist objectives; known text updates its check state, new text appends",
      ),
    giver: z
      .string()
      .optional()
      .describe("Who issued the quest, when the narrative names them"),
    reward: z.string().optional().describe("Stated reward, if any"),
  });

  return tool({
    name: "upsert-quests",
    description:
      "Batch create or advance quests (max 5 per call). Quests are de-duplicated by name: a known name merges the provided fields into the existing record (objectives matched by verbatim text), a new name creates a quest. No need to list existing data first — the tool merges internally.",
    parameters: z.object({
      quests: z
        .array(questSchema)
        .min(1)
        .max(MAX_QUESTS_PER_CALL)
        .describe("Quests to create or advance this turn, max 5"),
    }),
    execute: async (params, context) => {
      const now = new Date().toISOString();
      // Authoritative logical turn; `-1` marks "unknown" for callers outside
      // a turn rather than silently pretending turn 0 (npc-graph convention).
      const currentTurn = context.turnNumber ?? -1;
      // zod already caps LLM calls at 5; the slice keeps direct callers
      // (tests, RPC drift) within the same contract instead of rejecting.
      const incoming = (params.quests ?? []).slice(0, MAX_QUESTS_PER_CALL);

      // ── 1. Load existing quests and index them by normalized name ──
      const existingRows =
        (await store.listPluginData(
          context.sessionId,
          context.pluginId,
          "quests",
        )) ?? [];
      /** @type {Map<string, { key: string, value: any }>} */
      const rowByName = new Map();
      for (const row of existingRows) {
        const value = row?.value ?? {};
        if (typeof value.name !== "string" || !value.name.trim()) continue;
        // Imported world-pack rows may be keyed differently from value.id —
        // always write back through the actual row key.
        rowByName.set(normalizeName(value.name), {
          key: row.key ?? value.id,
          value,
        });
      }

      // ── 2. Assign stable short IDs to quests that don't exist yet ──
      const newNames = incoming
        .map((quest) => quest.name)
        .filter((name) => name.trim() && !rowByName.has(normalizeName(name)));
      const assignedIds =
        newNames.length > 0
          ? shortIdBatch("quest", newNames, context.sessionId)
          : [];
      /** @type {Map<string, string>} */
      const newNameToId = new Map();
      for (let i = 0; i < newNames.length; i += 1) {
        newNameToId.set(normalizeName(newNames[i]), assignedIds[i]);
      }

      // ── 3. Merge or create, collecting writes and change summaries ──
      /** @type {Array<{ namespace: string; key: string; value: any }>} */
      const writes = [];
      /** @type {Array<{ id: string; name: string; change: string; badge: any; color: string; detail: string }>} */
      const changes = [];
      /** @type {Array<{ id: string; name: string; change: string; status: string }>} */
      const results = [];

      for (const quest of incoming) {
        const lookupKey = normalizeName(quest.name);
        if (!lookupKey) continue;
        const match = rowByName.get(lookupKey);

        let stored;
        let change;
        if (match) {
          const previous = match.value;
          const objectives = mergeObjectives(
            previous.objectives,
            quest.objectives,
          );
          const previousStatus = previous.status ?? "active";
          const status = quest.status ?? previousStatus;
          stored = {
            ...previous,
            id: previous.id ?? match.key,
            name: previous.name,
            description: quest.description ?? previous.description ?? "",
            status,
            objectives,
            giver: quest.giver ?? previous.giver,
            reward: quest.reward ?? previous.reward,
            isNew: false,
            updatedTurn: currentTurn,
            updatedAt: now,
          };
          change =
            status !== previousStatus &&
            (status === "completed" || status === "failed")
              ? status
              : "progress";
          writes.push({
            namespace: "quests",
            key: match.key,
            value: { ...stored, chips: toChips(stored) },
          });
          // Later entries in the same call merge against the staged value
          // instead of the pre-turn store (writes don't commit mid-call).
          rowByName.set(lookupKey, { key: match.key, value: stored });
        } else {
          const id = newNameToId.get(lookupKey);
          if (!id) continue;
          stored = {
            id,
            name: quest.name,
            description: quest.description ?? "",
            status: quest.status ?? "active",
            objectives: (quest.objectives ?? []).map((objective) => ({
              text: objective.text.trim(),
              done: objective.done ?? false,
            })),
            giver: quest.giver,
            reward: quest.reward,
            isNew: true,
            createdTurn: currentTurn,
            updatedTurn: currentTurn,
            createdAt: now,
            updatedAt: now,
          };
          change = "new";
          writes.push({
            namespace: "quests",
            key: id,
            value: { ...stored, chips: toChips(stored) },
          });
          rowByName.set(lookupKey, { key: id, value: stored });
        }

        const meta = CHANGE_META[change];
        changes.push({
          id: stored.id,
          name: stored.name,
          change,
          badge: meta.badge,
          color: meta.color,
          detail: objectiveProgress(stored.objectives),
        });
        results.push({
          id: stored.id,
          name: stored.name,
          change,
          status: stored.status,
        });
      }

      // ── 4. Stage this turn's change summary for the message block ──
      if (changes.length > 0) {
        writes.push(
          { namespace: "message", key: "__turnId", value: context.turnId },
          { namespace: "message", key: "changes", value: changes },
        );
      }

      return withPendingProposals(
        {
          upserted: results.length,
          created: results.filter((r) => r.change === "new").length,
          advanced: results.filter((r) => r.change !== "new").length,
          quests: results,
        },
        writes.length > 0
          ? [makeProposal(context, now, "plugin.data.batch", { items: writes })]
          : [],
      );
    },
  });
}

function normalizeName(name) {
  return (name ?? "").trim().toLowerCase();
}

/**
 * Merge incoming objectives into the existing list: verbatim text match
 * updates the check state (only when `done` was provided), unknown text
 * appends. Returns a fresh array — the previous list is never mutated.
 */
function mergeObjectives(previous, incoming) {
  const merged = (previous ?? []).map((objective) => ({
    text: objective.text,
    done: objective.done ?? false,
  }));
  for (const objective of incoming ?? []) {
    const text = (objective.text ?? "").trim();
    if (!text) continue;
    const index = merged.findIndex((o) => (o.text ?? "").trim() === text);
    if (index >= 0) {
      merged[index] = {
        ...merged[index],
        done: objective.done ?? merged[index].done,
      };
    } else {
      merged.push({ text, done: objective.done ?? false });
    }
  }
  return merged;
}

/**
 * Derive the language-neutral chip strings the right panel renders:
 * one ✓/☐ chip per objective, plus ⚑ giver and ✦ reward when present.
 */
function toChips(quest) {
  const chips = (quest.objectives ?? []).map(
    (objective) => `${objective.done ? "✓" : "☐"} ${objective.text}`,
  );
  if (quest.giver) chips.push(`⚑ ${quest.giver}`);
  if (quest.reward) chips.push(`✦ ${quest.reward}`);
  return chips;
}

function objectiveProgress(objectives) {
  if (!objectives || objectives.length === 0) return "";
  const done = objectives.filter((objective) => objective.done).length;
  return `${done}/${objectives.length}`;
}
