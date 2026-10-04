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
  RuntimeEffects,
  UIRenderInstruction,
} from "@covel/shared";
import {
  collectAssetGenerations,
  makeProposal,
} from "../session/session-kernel-helpers.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A domain effect {@link normalizeOutput} cannot turn into a proposal. */
export interface MalformedDomainEffect {
  /** Proposal type the malformed entry would have become. */
  readonly type: "interaction.request" | "narrative.append" | "ui.render";
  readonly error: string;
}

/**
 * Find the first effect entry {@link normalizeOutput} reads fields from that is
 * not an object. Such an entry is a rejected write of its runtime, reported
 * here so no caller has to survive a thrown TypeError.
 */
export function malformedDomainEffect(
  effects: RuntimeEffects | undefined,
): MalformedDomainEffect | undefined {
  if (!effects) return undefined;
  for (const [channel, type] of [
    ["interactions", "interaction.request"],
    ["notifications", "narrative.append"],
  ] as const) {
    const entries: unknown = effects[channel];
    if (!Array.isArray(entries)) continue;
    const index = entries.findIndex((entry) => !isRecord(entry));
    if (index >= 0)
      return { type, error: `effects.${channel}[${index}] is not an object` };
  }
  const blocks: unknown = effects.ui;
  if (!Array.isArray(blocks)) return undefined;
  for (const [index, block] of blocks.entries()) {
    if (!isRecord(block) || !Array.isArray(block.parts)) continue;
    const part = block.parts.findIndex((entry) => !isRecord(entry));
    if (part >= 0)
      return {
        type: "ui.render",
        error: `effects.ui[${index}].parts[${part}] is not an object`,
      };
  }
  return undefined;
}

/**
 * Turn a success result into proposals. Callers reject the result first when
 * {@link malformedDomainEffect} reports an entry.
 */
export function normalizeOutput(
  output: Record<string, unknown>,
  source: ProposalSource,
  turnId: string,
  sessionId: string,
  outputKind?: string,
  effects: RuntimeEffects = {},
): Proposal[] {
  const proposals: Proposal[] = [];
  const kind = outputKind ?? "plugin";

  // narrative.append — from narrativeOutput.
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
    kind === "story" && typeof output.narrativeOutput === "string"
      ? output.narrativeOutput
      : "";

  if (narrativeText) {
    proposals.push(
      makeProposal("narrative.append", source, turnId, sessionId, {
        content: narrativeText,
        kind,
      }),
    );
  }

  // Only the explicit effects channel can request domain changes.
  const interactions = effects.interactions as
    Array<Record<string, unknown>> | undefined;
  if (interactions && interactions.length > 0) {
    for (const inter of interactions) {
      if (typeof inter.interactionId !== "string" || !inter.interactionId) {
        continue;
      }
      proposals.push(
        makeProposal("interaction.request", source, turnId, sessionId, {
          interactionId: inter.interactionId,
          type: inter.type ?? "form",
          ...inter,
        }),
      );
    }
  }

  const uiBlocks = (Array.isArray(effects.ui) ? effects.ui : []).filter(
    isRecord,
  );
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
  const statePatches = effects.statePatches as
    Array<Record<string, unknown>> | undefined;
  if (statePatches && statePatches.length > 0) {
    for (const patch of statePatches) {
      proposals.push(
        makeProposal("state.patch", source, turnId, sessionId, patch),
      );
    }
  }

  // Business output may use the same keys; it is never inspected here.
  const events = Array.isArray(effects.events) ? effects.events : [];
  for (const evt of events) {
    if (
      !evt ||
      typeof evt !== "object" ||
      Array.isArray(evt) ||
      !("topic" in evt)
    ) {
      continue;
    }
    proposals.push(
      makeProposal(
        "event.emit",
        source,
        turnId,
        sessionId,
        evt as Record<string, unknown>,
      ),
    );
  }

  // asset.generate — from effects.assetGenerations[]. Accepted entry shape:
  // { ref: MediaRef, modality: string, meta?: object }.
  for (const asset of collectAssetGenerations(effects)) {
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
  const pluginData = effects.pluginData as
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
  const notifications = effects.notifications as
    Array<Record<string, unknown>> | undefined;
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
