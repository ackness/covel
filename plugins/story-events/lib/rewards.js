import {
  labelText,
  makeProposal,
  pickLocaleText,
  resolveI18nText,
} from "@covel/plugin-handlers-utils";
import { INVENTORY_CHANGE_CONTRACT } from "./constants.js";
import { normalizeActionText } from "./state-readers.js";

export function rewardKeyOf(eventId, optionId, rewardId) {
  return `${eventId}:${optionId ?? ""}:${rewardId}`;
}

/**
 * Check whether an item was already added to the bag earlier in the same turn
 * (via `inventory.change@1` or `worldIR` `inventory_change` gain), preventing
 * double-granting when settling hidden rewards in `audit`.
 */
export function itemAlreadyAddedThisTurn(itemName, operations = [], worldIR) {
  const needle = normalizeActionText(itemName);
  if (!needle) return false;
  for (const op of operations) {
    if (op?.contract !== INVENTORY_CHANGE_CONTRACT) continue;
    const list = Array.isArray(op.request?.changes)
      ? op.request.changes
      : Array.isArray(op.result?.results)
        ? op.result.results
        : [];
    for (const change of list) {
      if (change?.op === "add" && normalizeActionText(change.item) === needle)
        return true;
    }
  }
  if (worldIR && Array.isArray(worldIR.events)) {
    const entityById = new Map(
      (worldIR.entities ?? []).map((entity) => [entity.id, entity.name]),
    );
    for (const ev of worldIR.events) {
      if (ev?.type !== "inventory_change") continue;
      if (ev.attributes?.operation !== "gain") continue;
      const itemId = ev.attributes?.item;
      const resolvedName = entityById.get(itemId) ?? itemId;
      if (normalizeActionText(resolvedName) === needle) return true;
    }
  }
  return false;
}

function rewardBadge(ctx, kind) {
  // Literal texts so check-plugin-i18n can extract every label for translation.
  if (kind === "item") return labelText(ctx, "Item");
  if (kind === "lorebook") return labelText(ctx, "Lore");
  return labelText(ctx, "Reward");
}

const REWARD_COLOR = {
  item: "amber",
  lorebook: "purple",
  narrative: "green",
};

/**
 * Atomically settle granted hidden rewards (`item`, `lorebook`, `narrative`).
 * - Idempotent across retries via `claimedRewards` keyed by `rewardKeyOf`.
 * - Deduplicates `item` grants against `operations` and `worldIR`.
 * - Degrades gracefully to a narrative note when `inventory.change@1` is absent.
 */
export async function grantRewards(
  ctx,
  {
    grants,
    claimedRewards = {},
    operations = [],
    worldIR,
    turn,
    turnId,
    sourceTurnId,
  },
) {
  const pending = grants.filter((grant) => {
    const key = rewardKeyOf(grant.eventId, grant.optionId, grant.reward.id);
    return !claimedRewards[key];
  });
  if (pending.length === 0) {
    return {
      proposals: [],
      narrativeNotes: [],
      announcements: [],
      claimedWrites: [],
      diagnostics: [],
    };
  }

  const locale = ctx.locale;
  const now = new Date().toISOString();
  const proposals = [];
  const narrativeNotes = [];
  const announcements = [];
  const claimedWrites = [];
  const diagnostics = [];

  // 1. Batch item grants through `inventory.change@1` when available.
  const itemGrants = pending.filter((g) => g.reward.kind === "item");
  const itemStatus = new Map();
  if (itemGrants.length > 0) {
    const toCall = [];
    for (const grant of itemGrants) {
      const key = rewardKeyOf(grant.eventId, grant.optionId, grant.reward.id);
      const itemName = resolveI18nText(grant.reward.item, locale)?.trim() ?? "";
      if (!itemName) {
        itemStatus.set(key, { ok: false, degraded: true, itemName: "" });
        continue;
      }
      if (itemAlreadyAddedThisTurn(itemName, operations, worldIR)) {
        itemStatus.set(key, {
          ok: true,
          deduped: true,
          degraded: false,
          itemName,
        });
        continue;
      }
      const description = grant.reward.description
        ? resolveI18nText(grant.reward.description, locale)?.trim()
        : undefined;
      const tags = Array.isArray(grant.reward.tags)
        ? grant.reward.tags
            .map((tag) => resolveI18nText(tag, locale)?.trim())
            .filter(Boolean)
        : undefined;
      toCall.push({
        key,
        itemName,
        change: {
          op: "add",
          item: itemName,
          quantity: grant.reward.quantity ?? 1,
          ...(description ? { description: description.slice(0, 200) } : {}),
          ...(tags?.length ? { tags: tags.slice(0, 5) } : {}),
        },
      });
    }

    if (toCall.length > 0) {
      let providers = [];
      try {
        providers =
          (await ctx.services?.discover(INVENTORY_CHANGE_CONTRACT)) ?? [];
      } catch {
        ctx.signal?.throwIfAborted();
      }
      if (providers.length === 1) {
        try {
          await ctx.services.call(
            {
              ...providers[0],
              input: { changes: toCall.map((entry) => entry.change) },
            },
            { signal: ctx.signal },
          );
          for (const entry of toCall) {
            itemStatus.set(entry.key, {
              ok: true,
              degraded: false,
              itemName: entry.itemName,
            });
          }
        } catch {
          ctx.signal?.throwIfAborted();
          diagnostics.push("inventory.change@1 refused hidden item reward");
          for (const entry of toCall) {
            itemStatus.set(entry.key, {
              ok: false,
              degraded: true,
              itemName: entry.itemName,
            });
          }
        }
      } else {
        for (const entry of toCall) {
          itemStatus.set(entry.key, {
            ok: false,
            degraded: true,
            itemName: entry.itemName,
          });
        }
      }
    }
  }

  // 2. Collect lorebook entries into one `lorebook.upsert` proposal.
  const loreEntries = [];

  for (const grant of pending) {
    const { eventId, optionId, reward } = grant;
    const key = rewardKeyOf(eventId, optionId, reward.id);
    const title = reward.title
      ? resolveI18nText(reward.title, locale)?.trim()
      : undefined;
    const announce = reward.announce !== false;

    if (reward.kind === "item") {
      const outcome = itemStatus.get(key) ?? { degraded: true, itemName: "" };
      const qty = reward.quantity ?? 1;
      const itemLabel =
        outcome.itemName ||
        resolveI18nText(reward.item, locale)?.trim() ||
        reward.id;
      const displayTitle =
        title || (qty > 1 ? `${itemLabel} ×${qty}` : itemLabel);
      const desc = reward.description
        ? resolveI18nText(reward.description, locale)?.trim()
        : "";
      if (outcome.degraded) {
        narrativeNotes.push(
          pickLocaleText(
            locale,
            `主角获得了隐藏物品「${displayTitle}」${desc ? `（${desc}）` : ""}。在故事中自然体现这一点。`,
            `The player character has obtained the hidden item "${displayTitle}"${desc ? ` (${desc})` : ""}. Reflect this naturally in the story.`,
          ),
        );
      }
      const record = {
        rewardKey: key,
        eventId,
        ...(optionId ? { optionId } : {}),
        rewardId: reward.id,
        kind: "item",
        title: displayTitle,
        ...(desc ? { detail: desc } : {}),
        badge: rewardBadge(ctx, "item"),
        color: REWARD_COLOR.item,
        announce,
        turn,
        turnId,
        sourceTurnId,
        ...(outcome.degraded ? { degraded: true } : {}),
      };
      claimedWrites.push({ key, value: record });
      if (announce) announcements.push(toAnnouncementItem(record));
      continue;
    }

    if (reward.kind === "lorebook") {
      const content = resolveI18nText(reward.content, locale)?.trim() ?? "";
      if (content) {
        loreEntries.push({
          id: reward.entryId,
          content,
          strategy: reward.strategy ?? "selective",
          ...(Array.isArray(reward.keys) && reward.keys.length
            ? { keys: reward.keys }
            : {}),
          ...(reward.position ? { position: reward.position } : {}),
          ...(Number.isInteger(reward.insertionOrder)
            ? { insertionOrder: reward.insertionOrder }
            : {}),
          enabled: true,
        });
      }
      const displayTitle = title || reward.entryId;
      const record = {
        rewardKey: key,
        eventId,
        ...(optionId ? { optionId } : {}),
        rewardId: reward.id,
        kind: "lorebook",
        title: displayTitle,
        badge: rewardBadge(ctx, "lorebook"),
        color: REWARD_COLOR.lorebook,
        announce,
        turn,
        turnId,
        sourceTurnId,
      };
      claimedWrites.push({ key, value: record });
      if (announce) announcements.push(toAnnouncementItem(record));
      continue;
    }

    if (reward.kind === "narrative") {
      const text = resolveI18nText(reward.text, locale)?.trim() ?? "";
      if (text) narrativeNotes.push(text);
      const displayTitle = title || text;
      const detail = title && text && title !== text ? text : "";
      const record = {
        rewardKey: key,
        eventId,
        ...(optionId ? { optionId } : {}),
        rewardId: reward.id,
        kind: "narrative",
        title: displayTitle,
        ...(detail ? { detail } : {}),
        badge: rewardBadge(ctx, "narrative"),
        color: REWARD_COLOR.narrative,
        announce,
        turn,
        turnId,
        sourceTurnId,
      };
      claimedWrites.push({ key, value: record });
      if (announce) announcements.push(toAnnouncementItem(record));
    }
  }

  if (loreEntries.length > 0) {
    proposals.push(
      makeProposal(ctx, now, "lorebook.upsert", { entries: loreEntries }),
    );
  }

  return {
    proposals,
    narrativeNotes,
    announcements,
    claimedWrites,
    diagnostics,
  };
}

export function toAnnouncementItem(record) {
  return {
    id: record.rewardKey,
    badge: record.badge,
    color: record.color,
    title: record.title,
    detail: record.detail ?? "",
  };
}

/** Format unlocked narrative/degraded reward notes for `story-context@1`. */
export function buildStoryContextNote(notes, locale) {
  const clean = (notes ?? [])
    .map((line) => (typeof line === "string" ? line.trim() : ""))
    .filter(Boolean);
  if (clean.length === 0) return null;
  return {
    title: pickLocaleText(locale, "隐藏奖励与解锁", "Hidden unlocks & rewards"),
    content: clean.map((line) => `- ${line}`).join("\n"),
  };
}
