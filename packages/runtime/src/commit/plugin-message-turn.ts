import type { Proposal } from "@covel/shared";

/**
 * `message.__turnId` is presentation metadata. A recovery attempt retains its
 * own proposal/trace identity while its cards belong to the recovered content.
 * Normalize only stamps referring to this execution; explicit other anchors
 * and plugin-owned data outside the message namespace remain untouched.
 */
export function anchorPluginMessage(
  proposal: Proposal,
  sourceTurnId: string | undefined,
): Proposal {
  if (!sourceTurnId || sourceTurnId === proposal.turnId) return proposal;
  const anchor = <T extends { namespace: string; key: string; value: unknown }>(
    item: T,
  ): T => {
    if (item.namespace !== "message") return item;
    if (item.key === "__turnId" && item.value === proposal.turnId) {
      return { ...item, value: sourceTurnId };
    }
    if (
      item.value &&
      typeof item.value === "object" &&
      !Array.isArray(item.value) &&
      "__turnId" in item.value &&
      item.value.__turnId === proposal.turnId
    ) {
      return {
        ...item,
        // Per-turn records use their turn stamp as the key (e.g. check history).
        key: item.key === proposal.turnId ? sourceTurnId : item.key,
        value: { ...item.value, __turnId: sourceTurnId },
      };
    }
    return item;
  };
  if (proposal.type === "plugin.data") {
    return { ...proposal, payload: anchor(proposal.payload) };
  }
  if (proposal.type === "plugin.data.batch") {
    return {
      ...proposal,
      payload: {
        ...proposal.payload,
        items: proposal.payload.items.map(anchor),
      },
    };
  }
  return proposal;
}
