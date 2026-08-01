/**
 * Plugin-local tool: update-inventory
 *
 * Batch-apply explicit inventory changes extracted from the current turn's
 * narrative: gains, losses/consumption, field corrections, and equip state.
 *
 * ### LLM contract
 *
 * The LLM provides changes keyed by item **name** (not ID). The tool is
 * responsible for:
 *
 *  1. Loading existing items from `plugin_data[namespace="items"]` and
 *     overlaying same-turn pending writes (a second call in one turn sees
 *     the first call's not-yet-committed items).
 *  2. De-duplicating by name (case-insensitive) and assigning stable short
 *     IDs to newly-named items via `shortIdBatch`.
 *  3. Stacking quantities on `add`, decrementing on `remove`, and tolerating
 *     removes of items that are not in the bag (skipped with a note instead
 *     of failing the whole batch).
 *  4. Writing a per-turn summary into the `message` namespace so the chat
 *     feed shows a "+ Iron Sword ×1 / − Torch ×2" style toast.
 *
 * Removal to zero writes a tombstone (`quantity: 0, removed: true`) instead
 * of deleting the row — no proposal type expresses plugin-data deletion, the
 * UI hides tombstones, and re-acquiring the same name revives the record so
 * the item keeps one stable ID across its whole history.
 */

import { makeProposal } from "@covel/plugin-handlers-utils";
import { withPendingProposals } from "@covel/tools";

/**
 * Badge metadata per op — persisted into the `message` namespace value so
 * the chat toast block renders locale-aware labels without any framework
 * lookup table.
 */
const OP_BADGES = {
  add: { label: { zh: "获得", en: "Gained" }, color: "green" },
  remove: { label: { zh: "失去", en: "Lost" }, color: "red" },
  set: { label: { zh: "更新", en: "Updated" }, color: "blue" },
  equip: { label: { zh: "装备", en: "Equipped" }, color: "purple" },
  unequip: { label: { zh: "卸下", en: "Unequipped" }, color: "amber" },
};

export default function ({ tool, z, shortIdBatch, store }) {
  const changeSchema = z.object({
    op: z
      .enum(["add", "remove", "set", "equip", "unequip"])
      .describe(
        "add=gain items, remove=lose/consume items, set=correct fields of an existing item, equip/unequip=toggle equipped state",
      ),
    name: z
      .string()
      .min(1)
      .describe(
        "Item name exactly as it appears in the narrative (used for de-duplication)",
      ),
    quantity: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "For add/remove: amount to add or subtract (default 1). For set: the new absolute quantity. Ignored by equip/unequip.",
      ),
    description: z
      .string()
      .optional()
      .describe(
        "1-2 factual sentences; when a vague bulk amount was quantified, note that the number is an estimate",
      ),
    tags: z
      .array(z.string())
      .max(5)
      .optional()
      .describe('Noun tags, e.g. ["weapon"] or ["currency"] for money'),
  });

  return tool({
    name: "update-inventory",
    description:
      "Batch-apply explicit inventory changes from this turn's narrative. Items are de-duplicated by name and quantities stack automatically — no need to list existing data first. Removing an item that is not in the bag is tolerated (skipped with a note).",
    parameters: z.object({
      changes: z
        .array(changeSchema)
        .min(1)
        .max(8)
        .describe("Item changes to apply this turn, max 8"),
    }),
    execute: async (params, context) => {
      const now = new Date().toISOString();

      // ── 1. Load committed items and overlay same-turn pending writes ──
      const rows =
        (await store.listPluginData(
          context.sessionId,
          context.pluginId,
          "items",
        )) ?? [];
      /** @type {Map<string, any>} */
      const itemByKey = new Map();
      for (const row of rows) {
        if (row.value && typeof row.value === "object") {
          itemByKey.set(row.key, row.value);
        }
      }
      const previousMessageChanges = overlayPendingWrites(itemByKey, context);

      /** @type {Map<string, string>} name (lowercased) → item key */
      const keyByName = new Map();
      for (const [key, value] of itemByKey) {
        if (typeof value.name === "string") {
          keyByName.set(value.name.toLowerCase(), key);
        }
      }
      const resolveKey = (name) =>
        keyByName.get(name.toLowerCase()) ??
        (itemByKey.has(name) ? name : undefined);

      // ── 2. Pre-assign short IDs for brand-new names in this batch ──
      const newNames = [];
      const seenNewNames = new Set();
      for (const change of params.changes) {
        if (change.op !== "add") continue;
        const lower = change.name.toLowerCase();
        if (resolveKey(change.name) !== undefined || seenNewNames.has(lower)) {
          continue;
        }
        seenNewNames.add(lower);
        newNames.push(change.name);
      }
      const assignedIds = shortIdBatch("item", newNames, context.sessionId);
      /** @type {Map<string, string>} */
      const idForNewName = new Map();
      for (let i = 0; i < newNames.length; i += 1) {
        idForNewName.set(newNames[i].toLowerCase(), assignedIds[i]);
      }

      // ── 3. Apply changes sequentially (later changes see earlier ones) ──
      /** @type {Map<string, any>} staged item writes, key → value */
      const staged = new Map();
      const results = [];
      const messageChanges = [];

      const stage = (key, value) => {
        staged.set(key, value);
        itemByKey.set(key, value);
        if (typeof value.name === "string") {
          keyByName.set(value.name.toLowerCase(), key);
        }
      };
      const pushMessage = (op, name, amount) => {
        const badge = OP_BADGES[op];
        const sign = op === "add" ? "+ " : op === "remove" ? "− " : "";
        const suffix = amount !== undefined ? ` ×${amount}` : "";
        messageChanges.push({
          op,
          text: `${sign}${name}${suffix}`,
          badge: badge.label,
          color: badge.color,
        });
      };

      for (const change of params.changes) {
        const key = resolveKey(change.name);
        const existing = key !== undefined ? itemByKey.get(key) : undefined;
        // Tombstones (removed items) count as "existing" only for ID reuse
        // on re-acquisition; remove/set/equip treat them as absent.
        const live =
          existing && existing.removed !== true ? existing : undefined;

        switch (change.op) {
          case "add": {
            const amount = change.quantity ?? 1;
            if (live) {
              const base =
                typeof live.quantity === "number" ? live.quantity : 0;
              stage(key, {
                ...live,
                quantity: base + amount,
                description: change.description ?? live.description,
                tags: mergeTags(live.tags, change.tags),
                updatedAt: now,
              });
              results.push({
                op: change.op,
                name: live.name,
                itemId: key,
                status: "updated",
                quantity: base + amount,
              });
            } else if (existing) {
              // Revive a tombstone: same name → same ID, fresh quantity.
              const { removed: _removed, ...rest } = existing;
              stage(key, {
                ...rest,
                quantity: amount,
                equipped: false,
                description: change.description ?? rest.description,
                tags: change.tags ?? rest.tags ?? [],
                updatedAt: now,
              });
              results.push({
                op: change.op,
                name: existing.name,
                itemId: key,
                status: "created",
                quantity: amount,
              });
            } else {
              const id = idForNewName.get(change.name.toLowerCase());
              stage(id, {
                id,
                name: change.name,
                quantity: amount,
                description: change.description ?? "",
                tags: change.tags ?? [],
                equipped: false,
                updatedAt: now,
              });
              results.push({
                op: change.op,
                name: change.name,
                itemId: id,
                status: "created",
                quantity: amount,
              });
            }
            pushMessage("add", change.name, amount);
            break;
          }

          case "remove": {
            if (!live) {
              results.push({
                op: change.op,
                name: change.name,
                status: "skipped",
                note: "not in inventory — nothing to remove",
              });
              break;
            }
            const amount = change.quantity ?? 1;
            const base = typeof live.quantity === "number" ? live.quantity : 0;
            const lost = Math.min(amount, base);
            const remaining = base - amount;
            if (remaining <= 0) {
              stage(key, {
                ...live,
                quantity: 0,
                equipped: false,
                removed: true,
                updatedAt: now,
              });
              results.push({
                op: change.op,
                name: live.name,
                itemId: key,
                status: "removed",
                ...(amount > base
                  ? { note: `only ${base} held — removed all` }
                  : {}),
              });
            } else {
              stage(key, { ...live, quantity: remaining, updatedAt: now });
              results.push({
                op: change.op,
                name: live.name,
                itemId: key,
                status: "updated",
                quantity: remaining,
              });
            }
            if (lost > 0) pushMessage("remove", live.name, lost);
            break;
          }

          case "set": {
            if (!live) {
              results.push({
                op: change.op,
                name: change.name,
                status: "skipped",
                note: "not in inventory — use add to create it",
              });
              break;
            }
            stage(key, {
              ...live,
              ...(change.description !== undefined
                ? { description: change.description }
                : {}),
              ...(change.tags !== undefined ? { tags: change.tags } : {}),
              ...(change.quantity !== undefined
                ? { quantity: change.quantity }
                : {}),
              updatedAt: now,
            });
            results.push({
              op: change.op,
              name: live.name,
              itemId: key,
              status: "updated",
            });
            pushMessage("set", live.name);
            break;
          }

          case "equip":
          case "unequip": {
            if (!live) {
              results.push({
                op: change.op,
                name: change.name,
                status: "skipped",
                note: "not in inventory — cannot change equip state",
              });
              break;
            }
            const equipped = change.op === "equip";
            if (live.equipped === equipped) {
              results.push({
                op: change.op,
                name: live.name,
                itemId: key,
                status: "skipped",
                note: equipped ? "already equipped" : "already unequipped",
              });
              break;
            }
            stage(key, { ...live, equipped, updatedAt: now });
            results.push({
              op: change.op,
              name: live.name,
              itemId: key,
              status: "updated",
            });
            pushMessage(change.op, live.name);
            break;
          }
        }
      }

      // ── 4. Persist item writes + per-turn message summary in one batch ──
      const items = [...staged].map(([key, value]) => ({
        namespace: "items",
        key,
        value,
      }));
      if (messageChanges.length > 0) {
        const merged = [...previousMessageChanges, ...messageChanges].map(
          (entry, index) => ({ ...entry, seq: index }),
        );
        items.push({
          namespace: "message",
          key: context.turnId,
          value: { turnId: context.turnId, changes: merged },
        });
      }

      const summary = {
        applied: results.filter((r) => r.status !== "skipped").length,
        skipped: results.filter((r) => r.status === "skipped").length,
        results,
      };
      if (items.length === 0) return summary;

      return withPendingProposals(summary, [
        makeProposal(context, now, "plugin.data.batch", { items }),
      ]);
    },
  });
}

/**
 * Overlay this turn's not-yet-committed writes onto the item map, so a
 * second tool call in the same turn sees the first call's items. Also
 * returns the pending message-summary changes for this turn (merged into
 * the new summary instead of being overwritten).
 *
 * @param {Map<string, any>} itemByKey
 * @param {{ sessionId: string; pluginId: string; turnId: string; pendingProposals?: any[] }} context
 * @returns {any[]} previously staged message changes for this turn
 */
function overlayPendingWrites(itemByKey, context) {
  const pending = Array.isArray(context.pendingProposals)
    ? context.pendingProposals
    : [];
  let previousMessageChanges = [];

  const apply = (item) => {
    if (!item || typeof item.key !== "string") return;
    if (item.namespace === "items") {
      if (item.value && typeof item.value === "object") {
        itemByKey.set(item.key, item.value);
      }
      return;
    }
    if (item.namespace === "message" && item.key === context.turnId) {
      const changes = item.value?.changes;
      if (Array.isArray(changes)) previousMessageChanges = changes;
    }
  };

  for (const proposal of pending) {
    if (!proposal || proposal.sessionId !== context.sessionId) continue;
    if (proposal.source?.pluginId !== context.pluginId) continue;
    if (proposal.type === "plugin.data") {
      apply(proposal.payload ?? {});
    } else if (proposal.type === "plugin.data.batch") {
      for (const item of proposal.payload?.items ?? []) apply(item);
    }
  }

  return previousMessageChanges;
}

function mergeTags(existing, newTags) {
  if (!newTags || newTags.length === 0) return existing ?? [];
  const set = new Set([...(existing ?? []), ...newTags]);
  return [...set].slice(0, 5);
}
