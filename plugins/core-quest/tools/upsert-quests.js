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
 *  3. Merging updates into existing quests: provided fields override;
 *     objectives match by stable ID, normalized text, then a conservative
 *     semantic fallback. Omitted `status`/`done` keep their current state so
 *     a partial update can never regress a completed quest or uncheck a
 *     finished objective.
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
    id: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe(
        "Stable objective ID from existing quest data; copy it when advancing an objective",
      ),
    text: z
      .string()
      .min(1)
      .describe(
        "Objective text; existing objectives match by ID first, then normalized or conservatively equivalent text",
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
        "Checklist objectives; copy an existing objective ID when available so wording changes still update the same item",
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
      "Batch create or advance quests (max 5 per call). Quests are de-duplicated by name: a known name merges provided fields into the existing record; objectives match by stable ID, normalized text, or a conservative semantic fallback. A new name creates a quest. No need to list existing data first — the tool merges internally.",
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
            previous.id ?? match.key,
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
            objectives: mergeObjectives([], quest.objectives, id),
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
 * Merge incoming objectives into the existing list. Stable ID is the primary
 * identity, normalized text handles punctuation/spacing drift, and a
 * conservative similarity check catches compact paraphrases without merging
 * ambiguous candidates. Existing canonical text is preserved on every match.
 * Returns a fresh array — the previous list is never mutated.
 */
function mergeObjectives(previous, incoming, questId) {
  const merged = [];
  for (const objective of previous ?? []) {
    const text = (objective?.text ?? "").trim();
    if (!text) continue;
    const candidate = {
      ...objective,
      id:
        normalizeObjectiveId(objective.id) ?? stableObjectiveId(questId, text),
      text,
      done: objective.done ?? false,
    };
    const duplicateIndex = findObjectiveIndex(
      merged,
      candidate.id,
      candidate.text,
    );
    if (duplicateIndex >= 0) {
      merged[duplicateIndex] = {
        ...merged[duplicateIndex],
        done: merged[duplicateIndex].done || candidate.done,
      };
    } else {
      merged.push(candidate);
    }
  }

  for (const objective of incoming ?? []) {
    const text = (objective.text ?? "").trim();
    if (!text) continue;
    const incomingId = normalizeObjectiveId(objective.id);
    const index = findObjectiveIndex(merged, incomingId, text);

    if (index >= 0) {
      merged[index] = {
        ...merged[index],
        done: objective.done ?? merged[index].done,
      };
    } else {
      merged.push({
        id: incomingId ?? stableObjectiveId(questId, text),
        text,
        done: objective.done ?? false,
      });
    }
  }
  return merged;
}

function findObjectiveIndex(existing, objectiveId, text) {
  let index = objectiveId
    ? existing.findIndex((candidate) => candidate.id === objectiveId)
    : -1;
  if (index < 0) {
    const normalizedText = normalizeObjectiveText(text);
    index = existing.findIndex(
      (candidate) => normalizeObjectiveText(candidate.text) === normalizedText,
    );
  }
  return index >= 0 ? index : findEquivalentObjectiveIndex(existing, text);
}

function normalizeObjectiveId(id) {
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function normalizeObjectiveText(text) {
  const normalized = (text ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
  // Leading urgency clauses describe timing rather than objective identity.
  // Keeping them would make two different objectives under the same deadline
  // look more similar than the same action expressed with different detail.
  return normalized
    .replace(/^赶在.{1,12}?前/u, "")
    .replace(/^在.{1,12}?之前/u, "")
    .replace(/^(立即|立刻|尽快|马上)/u, "");
}

function stableObjectiveId(questId, text) {
  const input = `${questId}:${normalizeObjectiveText(text)}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `objective-${(hash >>> 0).toString(36)}`;
}

function findEquivalentObjectiveIndex(existing, incomingText) {
  const incoming = normalizeObjectiveText(incomingText);
  const candidates = existing
    .map((objective, index) => ({
      index,
      score: objectiveSimilarity(
        normalizeObjectiveText(objective.text),
        incoming,
      ),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);

  if (candidates.length === 0) return -1;
  if (
    candidates.length > 1 &&
    candidates[0].score - candidates[1].score < 0.15
  ) {
    return -1;
  }
  return candidates[0].index;
}

function objectiveSimilarity(left, right) {
  if (left.length < 4 || right.length < 4) return 0;
  if (hasConflictingMovementIntent(left, right)) return 0;
  const commonSequence = longestCommonSubsequenceLength(left, right);
  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length);
  const commonBigrams = countCommonBigrams(left, right);
  const sequenceMatch =
    commonSequence >= 4 &&
    commonSequence / shorter >= 0.65 &&
    commonSequence / longer >= 0.4;
  const phraseMatch =
    commonBigrams >= 3 && commonBigrams / Math.max(1, shorter - 1) >= 0.3;

  if (
    (!sequenceMatch && !phraseMatch) ||
    (containsHan(left) &&
      containsHan(right) &&
      countCommonSalientHanCharacters(left, right) < 2)
  ) {
    return 0;
  }

  return (
    commonSequence / shorter +
    commonSequence / longer +
    commonBigrams / Math.max(1, shorter - 1)
  );
}

function hasConflictingMovementIntent(left, right) {
  const entering = ["进入", "潜入", "抵达", "到达"];
  const leaving = ["离开", "撤离", "返回", "逃离"];
  return (
    (entering.some((term) => left.includes(term)) &&
      leaving.some((term) => right.includes(term))) ||
    (leaving.some((term) => left.includes(term)) &&
      entering.some((term) => right.includes(term)))
  );
}

function containsHan(text) {
  return /\p{Script=Han}/u.test(text);
}

function countCommonSalientHanCharacters(left, right) {
  const generic = new Set(
    "进入内部上下前后完成前往到达抵达离开撤退返回并将把从向的了与和",
  );
  const rightCharacters = new Set(
    [...right].filter(
      (character) => containsHan(character) && !generic.has(character),
    ),
  );
  return new Set(
    [...left].filter(
      (character) =>
        containsHan(character) &&
        !generic.has(character) &&
        rightCharacters.has(character),
    ),
  ).size;
}

function longestCommonSubsequenceLength(left, right) {
  const row = new Uint16Array(right.length + 1);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = 0;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = row[rightIndex];
      row[rightIndex] =
        left[leftIndex - 1] === right[rightIndex - 1]
          ? diagonal + 1
          : Math.max(row[rightIndex], row[rightIndex - 1]);
      diagonal = above;
    }
  }
  return row[right.length];
}

function countCommonBigrams(left, right) {
  const rightBigrams = new Set();
  for (let index = 0; index < right.length - 1; index += 1) {
    rightBigrams.add(right.slice(index, index + 2));
  }
  const common = new Set();
  for (let index = 0; index < left.length - 1; index += 1) {
    const bigram = left.slice(index, index + 2);
    if (rightBigrams.has(bigram)) common.add(bigram);
  }
  return common.size;
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
