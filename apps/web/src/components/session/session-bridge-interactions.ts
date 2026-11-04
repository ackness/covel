import { z } from "zod";
import type { StreamMessage } from "@/stores/session-store.js";
import { readBlockInteractionRef } from "@/stores/session-store/submitted-interactions.js";
import { isPendingInteractionMessage } from "./game-view/interaction-blocks.js";

const text = z.string().max(8192);
const option = z.union([text, z.object({ value: text, label: text })]);
// These are public display fields. Executable validation and action maps stay
// with the host, even when nested inside otherwise valid interaction data.
const field = z.object({
  name: z.string().min(1).max(128),
  label: text,
  type: z.enum(["text", "textarea", "select", "checkbox", "number"]),
  placeholder: text.optional(),
  required: z.boolean().optional(),
  defaultValue: z.union([text, z.number().finite(), z.boolean()]).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  step: z.number().finite().positive().optional(),
  options: z.array(option).max(128).optional(),
});
export const publicInteractionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("form"),
    title: text.optional(),
    submitLabel: text.optional(),
    fields: z.array(field).min(1).max(64),
  }),
  z.object({
    type: z.literal("choice"),
    title: text.optional(),
    prompt: text.optional(),
    choices: z
      .array(z.object({ id: text, label: text, description: text.optional() }))
      .min(1)
      .max(128),
  }),
  z.object({
    type: z.literal("confirmation"),
    title: text.optional(),
    prompt: text.optional(),
    confirmLabel: text.optional(),
    cancelLabel: text.optional(),
  }),
  z.strictObject({ type: z.literal("unavailable") }),
]);
export type PublicInteraction = z.infer<typeof publicInteractionSchema>;
export function publicInteraction(
  block: Record<string, unknown>,
): PublicInteraction {
  const data = block.data ?? block;
  if (!data || typeof data !== "object" || Array.isArray(data))
    return { type: "unavailable" };
  const record = data as Record<string, unknown>;
  const type =
    typeof block.type === "string" && block.type.startsWith("interactive_")
      ? block.type.slice("interactive_".length)
      : record.type;
  if (type !== "form" && type !== "choice" && type !== "confirmation")
    return { type: "unavailable" };
  const result = publicInteractionSchema.safeParse({ ...record, type });
  return result.success ? result.data : { type: "unavailable" };
}

/** Host-only references. A new frame gets a new registry, never old handles. */
export function createInteractionHandles() {
  const entries = new Map<
    string,
    { message: StreamMessage; fingerprint: string; handle: string }
  >();
  const consumed = new Set<string>();
  let closed = false;
  const fingerprint = (message: StreamMessage) =>
    JSON.stringify([message.turnId, message.block]);
  return {
    sync(messages: readonly StreamMessage[], submitted: ReadonlySet<string>) {
      for (const [id, entry] of entries) {
        const message = messages.find((item) => item.id === id);
        if (
          !message ||
          fingerprint(message) !== entry.fingerprint ||
          !isPendingInteractionMessage(message, messages, submitted)
        )
          entries.delete(id);
      }
    },
    issue(message: StreamMessage): string | undefined {
      if (
        closed ||
        !message.block ||
        !readBlockInteractionRef(message.block, message.turnId).turnId
      )
        return;
      const key = fingerprint(message);
      let entry = entries.get(message.id);
      if (entry?.fingerprint !== key) {
        entry = { message, fingerprint: key, handle: crypto.randomUUID() };
        entries.set(message.id, entry);
      }
      return consumed.has(entry.handle) ? undefined : entry.handle;
    },
    resolve(
      handle: string,
      messages: readonly StreamMessage[],
      submitted: ReadonlySet<string>,
    ) {
      if (closed || consumed.has(handle)) return;
      this.sync(messages, submitted);
      const entry = [...entries.values()].find(
        (item) => item.handle === handle,
      );
      if (!entry?.message.block) return;
      const interaction = publicInteraction(entry.message.block);
      if (interaction.type === "unavailable") return;
      return {
        blockId: entry.message.id,
        ...readBlockInteractionRef(entry.message.block, entry.message.turnId),
        type: interaction.type,
      };
    },
    consume(handle: string) {
      consumed.add(handle);
    },
    close() {
      closed = true;
      entries.clear();
      consumed.clear();
    },
  };
}
