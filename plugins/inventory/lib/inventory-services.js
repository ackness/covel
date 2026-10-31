import {
  compareText,
  shortIdBatch,
  ToolError,
} from "@covel/plugin-handlers-utils";
import {
  inventoryLabels,
  newInventoryNames,
  planInventoryChanges,
} from "./update-inventory.js";

export async function bag({ query }, ctx) {
  const needle = query?.toLowerCase();
  const items = (await ctx.pluginData.list("items"))
    .map(({ value }) => value)
    .filter(
      (item) =>
        item &&
        typeof item.name === "string" &&
        item.removed !== true &&
        item.quantity > 0,
    )
    .map((item) => ({
      name: item.name,
      quantity: item.quantity,
      equipped: item.equipped === true,
      tags: Array.isArray(item.tags) ? item.tags : [],
      ...(typeof item.description === "string"
        ? { description: item.description }
        : {}),
    }))
    .filter(
      (item) =>
        !needle ||
        [item.name, ...item.tags].some((text) =>
          text.toLowerCase().includes(needle),
        ),
    )
    .sort(
      (a, b) =>
        Number(b.equipped) - Number(a.equipped) || compareText(a.name, b.name),
    );
  return { items: items.slice(0, 50), total: items.length };
}

/** Validate the whole exchange before the writer receives its first change. */
function checkHoldings(changes, items) {
  const view = new Map(items.map(({ key, value }) => [key, value]));
  const keys = new Map(
    items
      .filter(({ value }) => typeof value?.name === "string")
      .map(({ key, value }) => [value.name.toLowerCase(), key]),
  );
  for (const change of changes) {
    const lower = change.name.toLowerCase();
    const key =
      keys.get(lower) ?? (view.has(change.name) ? change.name : lower);
    const item = view.get(key);
    const held =
      item?.removed !== true && typeof item?.quantity === "number"
        ? Math.max(0, item.quantity)
        : 0;
    const amount = change.quantity ?? 1;
    if (change.op === "remove" && held < amount) {
      throw new ToolError(
        "refused",
        `${change.name}: holds ${held}, needs ${amount}`,
      );
    }
    if ((change.op === "equip" || change.op === "unequip") && held <= 0) {
      throw new ToolError("refused", `${change.name} is not in the bag`);
    }
    if (change.op === "add" || change.op === "remove") {
      view.set(key, {
        ...item,
        name: item?.name ?? change.name,
        quantity: held + (change.op === "add" ? amount : -amount),
        removed: false,
      });
      keys.set(lower, key);
    }
  }
}

export async function change({ changes: requested }, ctx) {
  const changes = requested.map(({ item, ...rest }) => ({
    ...rest,
    name: item,
  }));
  const items = await ctx.pluginData.list("items");
  checkHoldings(changes, items);
  const previous = await ctx.pluginData.get("message", ctx.turnId);
  const names = newInventoryNames(changes, items);
  const ids = shortIdBatch("item", names, ctx.sessionId, ctx.random);
  const plan = planInventoryChanges(changes, {
    items,
    previousMessage: previous,
    now: new Date().toISOString(),
    newIds: new Map(
      names.map((name, index) => [name.toLowerCase(), ids[index]]),
    ),
    labels: inventoryLabels(ctx),
  });
  for (const [key, ops] of plan.opsByKey) {
    await ctx.pluginData.update(
      "items",
      key,
      ops.map((op) => {
        // Service removals must still fit the latest holdings at commit.
        if (op.op !== "inc" || op.by >= 0) return op;
        const { onBound: _onBound, ...rejecting } = op;
        return rejecting;
      }),
    );
  }
  if (plan.messageChanges.length) {
    await ctx.pluginData.set("message", ctx.turnId, {
      ...previous,
      turnId: ctx.turnId,
      changes: plan.mergedMessageChanges,
    });
  }
  return {
    results: plan.summary.results.map(({ op, name, status, quantity }) => ({
      op,
      item: name,
      status,
      ...(quantity !== undefined ? { quantity } : {}),
    })),
  };
}
