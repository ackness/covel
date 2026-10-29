/**
 * One Zod schema per proposal type, checked before every commit.
 *
 * Plugin code is not bound by the payload types: a `.js` tool or handler can
 * hand over any object. The commit pipeline checks each payload against the
 * schema of its type before a handler runs, so a malformed write is a rejected
 * proposal (the commit-failure path, which drops only that runtime's writes
 * where the execution allows it), never a store error that rolls back the
 * whole execution. The schemas are a gate: they check the shape each handler
 * relies on, and the handler still applies its own rules (reserved
 * namespaces, size limits, character names, dimension providers, …).
 * Unknown fields are allowed and kept.
 */

import { z } from "zod";
import { dataOpsSchema } from "@covel/plugin-handlers-utils";
import type { ProposalPayloadMap, ProposalType } from "../types/proposal.js";
import { mediaRefSchema } from "../types/media.js";
import {
  characterSchemaSetPayloadSchema,
  characterUpsertPayloadSchema,
} from "./world-model.js";

const nonEmpty = z.string().min(1);
const record = z.record(z.string(), z.unknown());

const pluginDataItemSchema = z.object({
  namespace: nonEmpty,
  key: nonEmpty,
  value: z.unknown(),
});

export const proposalPayloadSchemas = {
  "narrative.append": z.object({ content: z.string(), kind: nonEmpty }),
  "event.emit": z.object({ topic: nonEmpty, data: record.optional() }),
  // A custom `type` renders as a generic interactive block.
  "interaction.request": z.object({
    interactionId: nonEmpty,
    type: z.string().optional(),
    title: z.string().optional(),
    data: record.optional(),
    narrativeTemplate: z.string().optional(),
    actionKind: z.string().min(1).optional(),
  }),
  "ui.render": z.object({ parts: z.array(record).min(1) }),
  "asset.generate": z.object({
    ref: mediaRefSchema,
    modality: nonEmpty,
    meta: record.optional(),
  }),
  "plugin.data": pluginDataItemSchema,
  "plugin.data.batch": z.object({
    items: z.array(pluginDataItemSchema).min(1),
  }),
  "plugin.data.delete": z.object({ namespace: nonEmpty, key: nonEmpty }),
  "plugin.data.update": z.object({
    namespace: nonEmpty,
    key: nonEmpty,
    ops: dataOpsSchema,
  }),
  "character.upsert": characterUpsertPayloadSchema,
  "character.schema.set": characterSchemaSetPayloadSchema,
  // The dimension handler applies the full schemas itself: an invalid update
  // of a narrative's settlement commits as a pending settlement, not a
  // rejected proposal.
  "dimension.initialize": record,
  "dimension.update": record,
  "lorebook.upsert": z.object({
    entries: z
      .array(
        z.object({
          id: nonEmpty,
          content: z.string(),
          strategy: z.enum(["constant", "selective"]),
          position: z.string().optional(),
          insertionOrder: z.number().optional(),
          enabled: z.boolean().optional(),
          keys: z.array(z.unknown()).optional(),
        }),
      )
      .min(1),
  }),
} as const satisfies { readonly [K in ProposalType]: z.ZodType };

export type ProposalPayloadCheck<K extends ProposalType = ProposalType> =
  | { readonly ok: true; readonly payload: ProposalPayloadMap[K] }
  | { readonly ok: false; readonly error: string };

/**
 * Check one payload before it is committed. A valid payload comes back as its
 * JSON copy — what every store keeps: fields that are `undefined` are dropped
 * and a `Date` becomes its ISO string. A value JSON cannot hold (a BigInt, a
 * circular reference) fails here instead of inside the store write.
 */
export function checkProposalPayload<K extends ProposalType>(
  type: K,
  payload: unknown,
): ProposalPayloadCheck<K> {
  const schema = (
    proposalPayloadSchemas as Record<string, z.ZodType | undefined>
  )[type];
  if (!schema) return { ok: false, error: `unknown proposal type: ${type}` };
  let copy: unknown;
  try {
    const text = JSON.stringify(payload);
    copy = text === undefined ? undefined : JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `${type}: payload is not JSON-serialisable (${reason})`,
    };
  }
  const parsed = schema.safeParse(copy);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map(
        (issue) =>
          `${issue.path.length > 0 ? issue.path.join(".") : "payload"}: ${issue.message}`,
      )
      .join("; ");
    return { ok: false, error: `${type}: invalid payload (${issues})` };
  }
  return { ok: true, payload: copy as ProposalPayloadMap[K] };
}
