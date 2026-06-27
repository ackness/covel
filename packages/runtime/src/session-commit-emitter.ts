/**
 * Fine-grained turn-emitter fan-out for committed proposals.
 */

import { assetGenerateToView } from "@covel/shared";
import type { CommitResult, Proposal } from "@covel/shared";
import type { TurnEmitter } from "./turn-emitter.js";
import { resolveBlockType } from "./session-kernel-helpers.js";

export async function emitCommittedProposal(
  emitter: TurnEmitter | undefined,
  proposal: Proposal,
  result: CommitResult,
): Promise<void> {
  if (!result.committed || !emitter) return;

  if (proposal.type === "interaction.request") {
    const payloadAny = { ...proposal.payload };
    await emitter.emit("block.emitted", {
      runtimeId: proposal.source.runtimeId,
      pluginId: proposal.source.pluginId,
      proposalId: proposal.id,
      source: proposal.source,
      // block.meta is already expressed by outer runtimeId/pluginId/turnId.
      block: {
        id: proposal.id,
        type: resolveBlockType(payloadAny),
        data: payloadAny,
      },
    });
  } else if (proposal.type === "ui.render") {
    const payload = proposal.payload;
    await emitter.emit("ui.rendered", {
      runtimeId: proposal.source.runtimeId,
      pluginId: proposal.source.pluginId,
      proposalId: proposal.id,
      source: proposal.source,
      render: payload,
    });
    for (const part of payload.parts) {
      await emitter.emit("ui.part.update", {
        runtimeId: proposal.source.runtimeId,
        pluginId: proposal.source.pluginId,
        proposalId: proposal.id,
        part,
      });
    }
  } else if (proposal.type === "state.patch") {
    const p = proposal.payload;
    await emitter.emit("state.patch.applied", {
      runtimeId: proposal.source.runtimeId,
      pluginId: proposal.source.pluginId,
      proposalId: proposal.id,
      // packageName / summary follow spec naming; semantically these are DB table / column from the state.patch payload.
      patch: {
        packageName: typeof p.table === "string" ? p.table : undefined,
        summary: typeof p.field === "string" ? p.field : undefined,
        ops: p,
      },
    });
  } else if (proposal.type === "asset.generate") {
    const view = assetGenerateToView(proposal);
    await emitter.emit("asset.generated", {
      runtimeId: proposal.source.runtimeId,
      pluginId: proposal.source.pluginId,
      proposalId: proposal.id,
      asset: view,
    });
  } else if (proposal.type === "character.upsert" && result.event) {
    await emitter.emit("character.upserted", {
      runtimeId: proposal.source.runtimeId,
      pluginId: proposal.source.pluginId,
      proposalId: proposal.id,
      character: result.event.payload.character,
    });
  }
}
