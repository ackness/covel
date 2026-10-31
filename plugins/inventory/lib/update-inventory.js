/**
 * Inventory ledger: batch-apply explicit inventory changes for the current
 * turn — gains, losses/consumption, and equip state. The
 * ledger runtime builds the changes from WorldIR inventory events
 * (`lib/world-ir.js`) and calls it once. The change service shares the pure
 * planner below, with stricter checks before staging the exchange.
 *
 * Changes are keyed by item **name** (not ID). The ledger:
 *
 *  1. Loads existing items from `plugin_data[namespace="items"]` and
 *     overlays same-turn pending writes.
 *  2. De-duplicates by name (case-insensitive) and assigns stable short IDs
 *     to newly-named items via `shortIdBatch`.
 *  3. Stacks quantities on `add`, decrements on `remove`, and tolerates
 *     removes of items that are not in the bag (skipped with a note instead
 *     of failing the whole batch).
 *  4. Writes a per-turn summary into the `message` namespace so the chat
 *     feed shows a "+ Iron Sword ×1 / − Torch ×2" style toast.
 *
 * Removal to zero writes a tombstone (`quantity: 0, removed: true`) instead
 * of deleting the row — the UI hides tombstones, and re-acquiring the same
 * name revives the record so the item keeps one stable ID across its whole
 * history.
 */

import {
  labelText,
  makeProposal,
  shortIdBatch,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";

/**
 * Badge color per op — persisted into the `message` namespace value so the
 * chat toast block renders it without any framework lookup table.
 */
const OP_COLORS = {
  add: "green",
  remove: "red",
  equip: "purple",
  unequip: "amber",
};

/**
 * The badge text in every language the plugin ships. Only the toast block
 * draws it; it picks the player's UI language.
 */
export function inventoryLabels(context) {
  // Each text is a literal: the validator reads them from the source.
  const badges = {
    add: labelText(context, "Gained"),
    remove: labelText(context, "Lost"),
    equip: labelText(context, "Equipped"),
    unequip: labelText(context, "Unequipped"),
  };
  return badges;
}

/** Names that need fresh IDs, in first-use order. Tombstones keep their IDs. */
export function newInventoryNames(changes, items) {
  const keys = new Set(
    items
      .filter(({ value }) => value && typeof value === "object")
      .map(({ key }) => key),
  );
  const known = new Set(
    items
      .filter(({ value }) => typeof value?.name === "string")
      .map(({ value }) => value.name.toLowerCase()),
  );
  const names = [];
  for (const change of changes) {
    if (change.op !== "add") continue;
    const lower = change.name.toLowerCase();
    if (known.has(lower) || keys.has(change.name)) continue;
    known.add(lower);
    names.push(change.name);
  }
  return names;
}

/** Plan without reading, writing, drawing randomness, or consulting the clock. */
export function planInventoryChanges(
  changes,
  { items, previousMessage, now, newIds, labels },
) {
  const itemByKey = new Map();
  for (const row of items) {
    if (row.value && typeof row.value === "object")
      itemByKey.set(row.key, row.value);
  }
  const previousMessageChanges = Array.isArray(previousMessage?.changes)
    ? previousMessage.changes
    : [];

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

  // Later changes see earlier ones in this plan.
  /** @type {Map<string, any>} staged item writes, key → value */
  const staged = new Map();
  const opsByKey = new Map();
  const results = [];
  const messageChanges = [];

  const stage = (key, value, ops) => {
    staged.set(key, value);
    opsByKey.set(key, [...(opsByKey.get(key) ?? []), ...ops]);
    itemByKey.set(key, value);
    if (typeof value.name === "string") {
      keyByName.set(value.name.toLowerCase(), key);
    }
  };
  const pushMessage = (op, name, amount) => {
    const sign = op === "add" ? "+ " : op === "remove" ? "− " : "";
    const suffix = amount !== undefined ? ` ×${amount}` : "";
    messageChanges.push({
      op,
      text: `${sign}${name}${suffix}`,
      badge: labels[op],
      color: OP_COLORS[op],
    });
  };

  for (const change of changes) {
    const key = resolveKey(change.name);
    const existing = key !== undefined ? itemByKey.get(key) : undefined;
    // Tombstones (removed items) count as "existing" only for ID reuse
    // on re-acquisition; remove and equip treat them as absent.
    const live = existing && existing.removed !== true ? existing : undefined;

    switch (change.op) {
      case "add": {
        const amount = change.quantity ?? 1;
        if (live) {
          const base = typeof live.quantity === "number" ? live.quantity : 0;
          stage(
            key,
            {
              ...live,
              quantity: base + amount,
              description: change.description ?? live.description,
              tags: mergeTags(live.tags, change.tags),
              updatedAt: now,
            },
            [
              typeof live.quantity === "number"
                ? { op: "inc", path: "/quantity", by: amount }
                : { op: "merge", value: { quantity: amount } },
              {
                op: "merge",
                value: {
                  ...(change.description !== undefined && {
                    description: change.description,
                  }),
                  tags: mergeTags(live.tags, change.tags),
                  updatedAt: now,
                },
              },
            ],
          );
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
          stage(
            key,
            {
              ...rest,
              quantity: amount,
              equipped: false,
              description: change.description ?? rest.description,
              tags: change.tags ?? rest.tags ?? [],
              updatedAt: now,
            },
            [
              { op: "inc", path: "/quantity", by: amount },
              {
                op: "merge",
                value: {
                  removed: null,
                  equipped: false,
                  ...(change.description !== undefined && {
                    description: change.description,
                  }),
                  tags: change.tags ?? rest.tags ?? [],
                  updatedAt: now,
                },
              },
            ],
          );
          results.push({
            op: change.op,
            name: existing.name,
            itemId: key,
            status: "created",
            quantity: amount,
          });
        } else {
          const id = newIds.get(change.name.toLowerCase());
          const value = {
            id,
            name: change.name,
            quantity: amount,
            description: change.description ?? "",
            tags: change.tags ?? [],
            equipped: false,
            updatedAt: now,
          };
          stage(id, value, [{ op: "set", value }]);
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
        const decrement = {
          op: "inc",
          path: "/quantity",
          by: -amount,
          min: 0,
          onBound: "clamp",
        };
        if (remaining <= 0) {
          stage(
            key,
            {
              ...live,
              quantity: 0,
              equipped: false,
              removed: true,
              updatedAt: now,
            },
            [
              decrement,
              {
                op: "merge",
                value: { equipped: false, removed: true, updatedAt: now },
              },
            ],
          );
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
          stage(key, { ...live, quantity: remaining, updatedAt: now }, [
            decrement,
            { op: "merge", value: { updatedAt: now } },
          ]);
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
        stage(key, { ...live, equipped, updatedAt: now }, [
          { op: "merge", value: { equipped, updatedAt: now } },
        ]);
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

  return {
    staged,
    opsByKey,
    messageChanges,
    mergedMessageChanges: [...previousMessageChanges, ...messageChanges].map(
      (entry, index) => ({ ...entry, seq: index }),
    ),
    summary: {
      applied: results.filter((r) => r.status !== "skipped").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      results,
    },
  };
}

export default async function updateInventory(params, context) {
  const now = new Date().toISOString();
  const items = (await context.store.listPluginData("items")) ?? [];
  const previousMessage = await context.store.getPluginData(
    "message",
    context.turnId,
  );
  const names = newInventoryNames(params.changes, items);
  const ids = shortIdBatch("item", names, context.sessionId, context.random);
  const plan = planInventoryChanges(params.changes, {
    items,
    previousMessage: previousMessage?.value,
    now,
    newIds: new Map(
      names.map((name, index) => [name.toLowerCase(), ids[index]]),
    ),
    labels: inventoryLabels(context),
  });
  const proposals = [...plan.opsByKey].map(([key, ops]) =>
    makeProposal(context, now, "plugin.data.update", {
      namespace: "items",
      key,
      ops,
    }),
  );
  if (plan.messageChanges.length > 0) {
    proposals.push(
      makeProposal(context, now, "plugin.data.batch", {
        items: [
          {
            namespace: "message",
            key: context.turnId,
            value: {
              turnId: context.turnId,
              changes: plan.mergedMessageChanges,
            },
          },
        ],
      }),
    );
  }
  if (proposals.length === 0) return plan.summary;
  return withPendingProposals(plan.summary, proposals);
}

function mergeTags(existing, newTags) {
  if (!newTags || newTags.length === 0) return existing ?? [];
  const set = new Set([...(existing ?? []), ...newTags]);
  return [...set].slice(0, 5);
}
