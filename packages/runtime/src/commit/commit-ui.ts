/**
 * Commit handlers for the message-block render family — proposals that land
 * as an assistant message carrying a `block` in its metadata:
 * `interaction.request`, `ui.render`, and `asset.generate`.
 */

import {
  assetGenerateToView,
  instructionLocaleFor,
  isAssetGeneratePayload,
  pictureOf,
  type ShownPicture,
} from "@covel/shared";
import type { CommitResult, ProposalFor } from "@covel/shared";
import {
  makeEvent,
  resolveBlockType,
} from "../session/session-kernel-helpers.js";
import type { KernelStore } from "../session/session-kernel-store.js";
import type { CommitHandlerMap } from "./commit-handler-types.js";
import { commitError, requireNonEmptyArray } from "./commit-validators.js";

/**
 * What the conversation says where a picture appeared. Every model reads it
 * in the history, with or without image input; it holds what the picture
 * shows and no ID of the asset.
 */
function pictureNote(
  picture: ShownPicture,
  locale: string | undefined,
): string {
  const zh = instructionLocaleFor(locale) === "zh";
  if (!picture.caption)
    return zh
      ? "此处向玩家展示了一张图片。"
      : "A picture was shown to the player here.";
  return zh
    ? `此处向玩家展示了一张图片。画面内容：${picture.caption}`
    : `A picture was shown to the player here. It depicts: ${picture.caption}`;
}

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

    // The message above is what the player sees. The prompt history is built
    // from the turn messages, so a picture gets a row there too: its content
    // is the note, and `ui` holds the block for a model that reads images.
    // The row is of source `system`: it is the kernel's record of the
    // picture, not text the producing runtime wrote.
    const picture = pictureOf(view);
    if (picture && store.appendTurnMessage) {
      const session = await store.getSession?.(proposal.sessionId);
      await store.appendTurnMessage({
        id: proposal.id,
        sessionId: proposal.sessionId,
        turnId: proposal.turnId,
        sourceType: "system",
        sourcePluginId: proposal.source.pluginId,
        sourceRuntimeId: proposal.source.runtimeId,
        role: "user",
        content: pictureNote(picture, session?.locale),
        ui: [block],
        order: 99,
        createdAt: proposal.timestamp,
      });
    }

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
