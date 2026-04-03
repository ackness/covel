import type { CommitResult, ValidatedProposalEnvelope } from "@covel/shared";
import type { TurnState } from "../types.js";

/** Recursively merge plain objects; non-object values are overwritten. */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const tVal = result[key];
    const sVal = source[key];
    if (
      tVal && sVal &&
      typeof tVal === "object" && !Array.isArray(tVal) &&
      typeof sVal === "object" && !Array.isArray(sVal)
    ) {
      result[key] = deepMerge(
        tVal as Record<string, unknown>,
        sVal as Record<string, unknown>,
      );
    } else {
      result[key] = sVal;
    }
  }
  return result;
}

/**
 * In-memory commit service for first-round implementation.
 *
 * Applies validated proposals to the turn state:
 * - narrative.append → append to narrative segments
 * - state.patch → deep merge into state object
 * - event.emit → append to events list
 * - record.upsert → upsert into records map
 * - ui.render → append to render blocks
 * - asset.generate → no-op (first-round)
 */
export function commitProposals(
  turnState: TurnState,
  validated: ValidatedProposalEnvelope[],
  turnContext: { turnId: string; branchId: string }
): CommitResult {
  for (const envelope of validated) {
    for (const item of envelope.items) {
      switch (item.kind) {
        case "narrative.append": {
          const payload = item.payload as { text: string };
          turnState.narrativeSegments.push(payload.text);
          break;
        }
        case "state.patch": {
          const patch = item.payload as Record<string, unknown>;
          turnState.state = deepMerge(turnState.state, patch);
          break;
        }
        case "event.emit": {
          const event = item.payload as { type: string; payload?: unknown };
          turnState.events.push({
            type: event.type,
            payload: event.payload ?? {},
            timestamp: new Date().toISOString(),
          });
          break;
        }
        case "record.upsert": {
          const record = item.payload as { key: string; value: unknown };
          turnState.records.set(record.key, record.value);
          break;
        }
        case "ui.render": {
          const block = item.payload as { type: string; content: unknown };
          turnState.renderBlocks.push({
            type: block.type,
            content: block.content,
            source: {
              runtimeId: envelope.runtimeId,
              pluginId: envelope.pluginId,
            },
          });
          break;
        }
        case "asset.generate":
          // First-round: no-op
          console.warn("[kernel] asset.generate is not implemented in first round, proposal ignored");
          break;
      }
    }
  }

  return {
    commitId: `commit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    turnId: turnContext.turnId,
    branchId: turnContext.branchId,
    committedAt: new Date().toISOString(),
  };
}
