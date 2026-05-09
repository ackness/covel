/**
 * Runtime output normalisation
 *
 * Internal module split from session-kernel.ts. Keep public imports routed
 * through session-kernel.ts unless a caller intentionally needs this boundary.
 */

import { normalizeUIRenderInstruction } from "@covel/shared";
import type {
  Proposal,
  ProposalSource,
  UIRenderInstruction,
} from "@covel/shared";
import {
  collectAssetGenerations,
  collectUiBlocks,
  makeProposal,
} from "./session-kernel-helpers.js";

export function normalizeOutput(
  output: Record<string, unknown>,
  source: ProposalSource,
  turnId: string,
  sessionId: string,
  outputKind?: string,
  toolCalls?: ReadonlyArray<{ output?: unknown }>,
): Proposal[] {
  const proposals: Proposal[] = [];
  const kind = outputKind ?? "plugin";

  // narrative.append — from narrativeOutput or content (fallback).
  //
  // Only `story` runtimes may append to the narrative feed. `system` and
  // `plugin` runtimes that happen to return `narrativeOutput` (e.g. a
  // tool-less LLM response on a non-story plugin) must NOT pollute the
  // chat stream — their text is still available via RuntimeResult.output
  // for trace and debug consumers. This blocks the guide failure
  // mode where the LLM ignored `generate-guide` and wrote a narrative
  // continuation that the framework silently committed alongside
  // narrator's real output.
  const narrativeText =
    kind === "story"
      ? (typeof output.narrativeOutput === "string" &&
          output.narrativeOutput) ||
        (typeof output.content === "string" && output.content) ||
        ""
      : "";

  if (narrativeText) {
    proposals.push(
      makeProposal("narrative.append", source, turnId, sessionId, {
        content: narrativeText,
        kind,
      }),
    );
  }

  // interaction.request — from interactions[] (modern) or form (legacy)
  const interactions = output.interactions as
    | Array<Record<string, unknown>>
    | undefined;
  if (interactions && interactions.length > 0) {
    for (const inter of interactions) {
      proposals.push(
        makeProposal("interaction.request", source, turnId, sessionId, {
          interactionId: inter.interactionId ?? inter.formId ?? "",
          type: inter.type ?? "form",
          ...inter,
        }),
      );
    }
  } else if (output.form && typeof output.form === "object") {
    const form = output.form as Record<string, unknown>;
    proposals.push(
      makeProposal("interaction.request", source, turnId, sessionId, {
        interactionId: (form.formId ?? "") as string,
        type: "form",
        ...form,
      }),
    );
  }

  // ui blocks — from runtime output or tool-call parsed results
  const uiBlocks = collectUiBlocks(output, toolCalls);
  for (const [index, block] of uiBlocks.entries()) {
    const fallbackId =
      (typeof block.interactionId === "string" && block.interactionId) ||
      (typeof block.id === "string" && block.id) ||
      `ui-${index + 1}`;
    proposals.push(
      makeProposal("ui.render", source, turnId, sessionId, {
        ...normalizeUIRenderInstruction(
          block as unknown as UIRenderInstruction,
          fallbackId,
        ),
      }),
    );
  }

  // state.patch — from statePatches[]
  const statePatches = output.statePatches as
    | Array<Record<string, unknown>>
    | undefined;
  if (statePatches && statePatches.length > 0) {
    for (const patch of statePatches) {
      proposals.push(
        makeProposal("state.patch", source, turnId, sessionId, patch),
      );
    }
  }

  // Legacy `phase` field from runtime output is ignored. The session state
  // model is now `status + turnCount + preGameCompleted` — there is no
  // persistent `phase` column and no `phase.changed` event is forwarded.
  // Runtimes that still include `phase` in their output are silently
  // accepted (no error) so plugins can upgrade on their own schedule.

  // event.emit — from events[]
  const events = output.events as Array<Record<string, unknown>> | undefined;
  if (events && events.length > 0) {
    for (const evt of events) {
      proposals.push(
        makeProposal("event.emit", source, turnId, sessionId, evt),
      );
    }
  }

  // asset.generate — from output.assetGenerations[] (canonical, per SPEC §5.7)
  // or output.assets[] (alias kept for the bundled image plugins whose P0-c
  // diffs documented `assets` as the wire field). Accepted entry shape:
  // { ref: MediaRef, modality: string, meta?: object }.
  for (const asset of collectAssetGenerations(output)) {
    proposals.push(
      makeProposal("asset.generate", source, turnId, sessionId, {
        ref: asset.ref,
        modality: asset.modality,
        ...(asset.meta ? { meta: asset.meta } : {}),
      }),
    );
  }

  // plugin.data / plugin.data.batch — from pluginData[]. Each entry is
  // `{ namespace, key, value }`. Single entry → plugin.data, multiple → a
  // batched plugin.data.batch so commits happen in one store call. Function
  // runtimes need this to write their own namespace (e.g. image galleries,
  // job state, per-session caches) without reaching into DataStore directly.
  const pluginData = output.pluginData as
    | Array<{
        namespace?: unknown;
        key?: unknown;
        value?: unknown;
      }>
    | undefined;
  if (Array.isArray(pluginData) && pluginData.length > 0) {
    const items = pluginData
      .filter(
        (item): item is { namespace: string; key: string; value: unknown } =>
          !!item &&
          typeof item === "object" &&
          typeof item.namespace === "string" &&
          item.namespace.length > 0 &&
          typeof item.key === "string" &&
          item.key.length > 0 &&
          "value" in item,
      )
      .map((item) => ({
        namespace: item.namespace,
        key: item.key,
        value: item.value,
      }));
    if (items.length === 1) {
      proposals.push(
        makeProposal("plugin.data", source, turnId, sessionId, items[0]),
      );
    } else if (items.length > 1) {
      proposals.push(
        makeProposal("plugin.data.batch", source, turnId, sessionId, { items }),
      );
    }
  }

  // notifications[] — system-level messages surfaced to the chat feed.
  // Each notification is normalised into a narrative.append proposal with
  // kind='system' so it flows through the same commit path as any assistant
  // message without requiring a new proposal type or frontend wiring.
  //
  // Plugins that want a richer notification UI can additionally emit
  // `events: [{ topic: 'notification.shown', data: {...} }]` — the event.emit
  // branch above already handles that and the frontend can subscribe.
  const notifications = output.notifications as
    | Array<Record<string, unknown>>
    | undefined;
  if (notifications && notifications.length > 0) {
    for (const n of notifications) {
      const title = typeof n.title === "string" ? n.title.trim() : "";
      const message = typeof n.message === "string" ? n.message.trim() : "";
      if (!title && !message) continue; // empty notification — skip
      const content =
        title && message ? `${title}\n${message}` : title || message;
      proposals.push(
        makeProposal("narrative.append", source, turnId, sessionId, {
          content,
          kind: "system",
        }),
      );
    }
  }

  return proposals;
}
