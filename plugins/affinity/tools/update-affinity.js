/**
 * Plugin-local tool: update-affinity
 *
 * Batch-apply player-to-NPC affinity deltas for the current turn.
 *
 * ### LLM contract
 *
 * The LLM provides changes keyed by canonical **name** (not ID). The tool:
 *
 *  1. Loads existing records from `plugin_data[namespace="affinity"]` and
 *     overlays same-turn pending writes (tool calls within one turn do not
 *     commit between each other, so a second call must see the first one).
 *  2. Matches names case-insensitively; unknown names get a stable short ID
 *     via `shortIdBatch` and start at score 0 before the delta applies.
 *  3. Accumulates `score` with clamping to [-100, 100] and re-derives the
 *     display fields (`tier` / `tierLabel` / `tierColor` / `scoreBar`) on
 *     every write. World-preseeded records ({id, name, score, notes?}) carry
 *     none of the derived fields until their first delta — that is tolerated
 *     here and the fields are backfilled on that first write.
 *  4. Appends `{turn, delta, reason}` to `history`, keeping the last 10.
 *  5. Writes this turn's changes into the `message` namespace so the
 *     chat-area toast block can render them (guide's `__turnId` convention).
 */

import { makeProposal } from "@covel/plugin-handlers-utils";
import { withPendingProposals } from "@covel/tools";
import { AFFINITY_MIN, clampScore, getTier } from "../tier-metadata.js";

const HISTORY_LIMIT = 10;
const MAX_CHANGES_PER_TURN = 5;
const MAX_DELTA = 20;

export default function ({ tool, z, shortIdBatch, store }) {
  const changeSchema = z.object({
    name: z
      .string()
      .min(1)
      .describe(
        "Canonical NPC name as it appears in the narrative (used for de-duplication)",
      ),
    delta: z
      .number()
      .int()
      .min(-MAX_DELTA)
      .max(MAX_DELTA)
      .describe(
        "Affinity change this turn: ±1..5 for everyday interactions, up to ±20 for major events; never 0",
      ),
    reason: z
      .string()
      .min(1)
      .describe(
        "One short sentence explaining the change, in the session language (shown to the player)",
      ),
  });

  return tool({
    name: "update-affinity",
    description:
      "Batch-apply player-to-NPC affinity changes for this turn. NPCs are de-duplicated by name; an unknown name is created at score 0 before its delta applies. Scores accumulate across turns and clamp to [-100, 100]; tiers are derived automatically.",
    parameters: z.object({
      changes: z
        .array(changeSchema)
        .min(1)
        .max(MAX_CHANGES_PER_TURN)
        .describe("Affinity changes for this turn, max 5"),
    }),
    execute: async (params, context) => {
      const now = new Date().toISOString();
      // Authoritative logical turn for history stamps; `-1` marks "unknown"
      // for callers outside a turn (same convention as npc-graph).
      const turn = context.turnNumber ?? -1;

      // ── 1. Load committed records, overlay same-turn pending writes ──
      const committedRows =
        (await store.listPluginData(
          context.sessionId,
          context.pluginId,
          "affinity",
        )) ?? [];
      /** @type {Map<string, { key: string, value: any }>} */
      const recordByName = new Map();
      const indexRow = (row) => {
        const v = row.value ?? {};
        if (typeof v.name !== "string" || v.name.length === 0) return;
        recordByName.set(v.name.toLowerCase(), { key: row.key, value: v });
      };
      for (const row of committedRows) indexRow(row);
      // Pending rows are in proposal order — later writes win in the index.
      for (const row of collectPendingAffinityRows(
        context.pendingProposals,
        context,
      )) {
        indexRow(row);
      }

      // ── 2. Assign stable short IDs to names not seen before ──
      const newNames = [];
      const seenNewNames = new Set();
      for (const change of params.changes) {
        const lookup = change.name.toLowerCase();
        if (!recordByName.has(lookup) && !seenNewNames.has(lookup)) {
          seenNewNames.add(lookup);
          newNames.push(change.name);
        }
      }
      const assignedIds =
        newNames.length > 0
          ? shortIdBatch("affinity", newNames, context.sessionId)
          : [];
      /** @type {Map<string, string>} */
      const newNameToId = new Map();
      for (let i = 0; i < newNames.length; i += 1) {
        newNameToId.set(newNames[i].toLowerCase(), assignedIds[i]);
      }

      // ── 3. Apply changes sequentially (duplicate names accumulate) ──
      /** @type {Map<string, any>} */
      const writes = new Map();
      const results = [];
      const messageChanges = [];

      for (const change of params.changes) {
        const lookup = change.name.toLowerCase();
        const existing = recordByName.get(lookup);
        const key = existing?.key ?? newNameToId.get(lookup);
        if (!key) continue;
        const prior = existing?.value ?? {
          id: key,
          name: change.name,
          score: 0,
        };

        const priorScore =
          typeof prior.score === "number" && Number.isFinite(prior.score)
            ? prior.score
            : 0;
        const score = clampScore(priorScore + change.delta);
        const tier = getTier(score);
        // World-preseeded records carry no history — treat missing as empty.
        const history = Array.isArray(prior.history) ? prior.history : [];
        const deltaText = formatDelta(change.delta);
        const deltaColor = change.delta < 0 ? "red" : "green";

        const value = {
          ...prior,
          id: prior.id ?? key,
          name: prior.name,
          score,
          // Derived for the right panel: json-render bindings cannot do
          // arithmetic, so the [-100, 100] score is pre-shifted to a
          // [0, 200] bar value (center = neutral).
          scoreBar: score - AFFINITY_MIN,
          tier: tier.id,
          tierLabel: tier.label,
          tierColor: tier.color,
          lastDelta: deltaText,
          lastDeltaColor: deltaColor,
          lastReason: change.reason,
          history: [
            ...history,
            { turn, delta: change.delta, reason: change.reason },
          ].slice(-HISTORY_LIMIT),
          updatedAt: now,
        };

        writes.set(key, value);
        recordByName.set(lookup, { key, value });
        results.push({
          id: key,
          name: value.name,
          score,
          tier: tier.id,
          status: existing ? "updated" : "created",
        });
        messageChanges.push({
          id: key,
          name: value.name,
          deltaText,
          deltaColor,
          score,
          tierLabel: tier.label,
          tierColor: tier.color,
          reason: change.reason,
        });
      }

      // ── 4. Persist records + this turn's toast payload in one batch ──
      const items = [...writes].map(([key, value]) => ({
        namespace: "affinity",
        key,
        value,
      }));
      items.push({
        namespace: "message",
        key: "__turnId",
        value: context.turnId,
      });
      items.push({
        namespace: "message",
        key: "changes",
        value: messageChanges,
      });

      return withPendingProposals(
        {
          applied: results.length,
          results,
        },
        [makeProposal(context, now, "plugin.data.batch", { items })],
      );
    },
  });
}

/**
 * Collect pending same-turn affinity writes so a second tool call in one
 * turn builds on the first instead of the stale pre-turn store (writes do
 * not commit between tool calls — same pattern codex's update tool uses).
 *
 * @returns {Array<{ key: string, value: any }>} rows in proposal order
 */
function collectPendingAffinityRows(pendingProposals, context) {
  if (!Array.isArray(pendingProposals) || pendingProposals.length === 0) {
    return [];
  }

  const rows = [];
  for (const proposal of pendingProposals) {
    if (!proposal || proposal.sessionId !== context.sessionId) continue;
    if (proposal.source?.pluginId !== context.pluginId) continue;

    if (proposal.type === "plugin.data") {
      if (proposal.payload?.namespace === "affinity") {
        rows.push({ key: proposal.payload.key, value: proposal.payload.value });
      }
      continue;
    }

    if (proposal.type === "plugin.data.batch") {
      for (const item of proposal.payload?.items ?? []) {
        if (item.namespace === "affinity") {
          rows.push({ key: item.key, value: item.value });
        }
      }
    }
  }
  return rows;
}

/**
 * @param {number} delta
 * @returns {string} signed display text, e.g. "+5" / "-3"
 */
function formatDelta(delta) {
  return delta > 0 ? `+${delta}` : `${delta}`;
}
