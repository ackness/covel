/**
 * Commit handlers for the message-block render family — proposals that land
 * as an assistant message carrying a `block` in its metadata:
 * `interaction.request`, `ui.render`, and `asset.generate`.
 */

import { assetGenerateToView, isAssetGeneratePayload } from "@covel/shared";
import type { CommitResult, ProposalFor } from "@covel/shared";
import {
  makeEvent,
  resolveBlockType,
} from "../session/session-kernel-helpers.js";
import type { KernelStore } from "../session/session-kernel-store.js";
import type { CommitHandlerMap } from "./commit-handler-types.js";
import { commitError, requireNonEmptyArray } from "./commit-validators.js";

export function createUiCommitHandlers(
  store: KernelStore,
): Pick<
  CommitHandlerMap,
  "interaction.request" | "ui.render" | "asset.generate"
> {
  async function commitInteraction(
    proposal: ProposalFor<"interaction.request">,
  ): Promise<CommitResult> {
    const payload = { ...proposal.payload };
    const block = {
      id: proposal.id,
      type: resolveBlockType(payload),
      data: payload,
      meta: {
        runtimeId: proposal.source.runtimeId,
        pluginId: proposal.source.pluginId,
        turnId: proposal.turnId,
      },
    };
    await store.addMessage({
      id: proposal.id,
      sessionId: proposal.sessionId,
      role: "assistant",
      content: "",
      metadata: {
        turnId: proposal.turnId,
        runtimeId: proposal.source.runtimeId,
        kind: "plugin",
        block,
      },
      createdAt: proposal.timestamp,
    });
    return {
      committed: true,
      event: makeEvent("interaction.requested", proposal, {
        ...payload,
        block,
      }),
    };
  }

  async function commitUIRender(
    proposal: ProposalFor<"ui.render">,
  ): Promise<CommitResult> {
    const payload = proposal.payload;
    const invalid = requireNonEmptyArray(
      payload.parts,
      "ui.render: parts must be a non-empty array",
    );
    if (invalid) return invalid;

    const block = {
      id: proposal.id,
      type: "ui.render",
      data: payload,
      meta: {
        runtimeId: proposal.source.runtimeId,
        pluginId: proposal.source.pluginId,
        turnId: proposal.turnId,
      },
    };

    await store.addMessage({
      id: proposal.id,
      sessionId: proposal.sessionId,
      role: "assistant",
      content: "",
      metadata: {
        turnId: proposal.turnId,
        runtimeId: proposal.source.runtimeId,
        kind: "plugin",
        block,
      },
      createdAt: proposal.timestamp,
    });

    return {
      committed: true,
      event: makeEvent("ui.rendered", proposal, { render: payload, block }),
    };
  }

  async function commitAssetGenerate(
    proposal: ProposalFor<"asset.generate">,
  ): Promise<CommitResult> {
    if (!isAssetGeneratePayload(proposal.payload)) {
      return commitError(
        "asset.generate: payload must be { ref: MediaRef, modality: string, meta?: object }",
      );
    }

    const view = assetGenerateToView(proposal);
    const block = {
      id: proposal.id,
      type: "asset.generate",
      data: view,
      meta: {
        runtimeId: proposal.source.runtimeId,
        pluginId: proposal.source.pluginId,
        turnId: proposal.turnId,
      },
    };

    await store.addMessage({
      id: proposal.id,
      sessionId: proposal.sessionId,
      role: "assistant",
      content: "",
      metadata: {
        turnId: proposal.turnId,
        runtimeId: proposal.source.runtimeId,
        kind: "plugin",
        block,
      },
      createdAt: proposal.timestamp,
    });

    return {
      committed: true,
      event: makeEvent("asset.generated", proposal, { asset: view, block }),
    };
  }

  return {
    "interaction.request": commitInteraction,
    "ui.render": commitUIRender,
    "asset.generate": commitAssetGenerate,
  };
}
