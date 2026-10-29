import { z } from "zod";
import type { SessionRecord } from "@/services/api.js";
import type { StreamMessage } from "@/stores/session-store.js";
import { isPendingInteractionMessage } from "./game-view/interaction-blocks.js";

export const SESSION_BRIDGE_VERSION = 1;
export const SESSION_BRIDGE_MAX_MESSAGES = 200;
export const SESSION_BRIDGE_MAX_MESSAGE_BYTES = 32 * 1024;
export const SESSION_BRIDGE_MAX_TEXT_BYTES = 256 * 1024;
export const SESSION_BRIDGE_MAX_STREAM_BYTES = 64 * 1024;
export const SESSION_BRIDGE_MAX_CHARACTERS = 100;
export const SESSION_BRIDGE_MAX_CHARACTER_BYTES = 8 * 1024;
export const SESSION_BRIDGE_MAX_PENDING = 8;
export const SESSION_BRIDGE_MAX_BLOCK_BYTES = 16 * 1024;
export const SESSION_BRIDGE_MAX_DEPTH = 8;

const hiddenKeys = new Set([
  "hidden",
  "concealed",
  "turnId",
  "requestId",
  "runtimeId",
  "sessionId",
  "timestamp",
  "createdAt",
  "updatedAt",
  "uuid",
]);

/** Copy only JSON values, dropping private keys before anything crosses the port. */
export function stripHiddenKeys(value: unknown, depth = 0): unknown {
  if (depth > SESSION_BRIDGE_MAX_DEPTH) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value))
    return value.map((item) => stripHiddenKeys(item, depth + 1));
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith("_") && !hiddenKeys.has(key))
      .map(([key, item]) => [key, stripHiddenKeys(item, depth + 1)]),
  );
}

const encoder = new TextEncoder();
export function boundedSessionText(text: string, bytes: number): string {
  if (encoder.encode(text).length <= bytes) return text;
  // Count code points so a UTF-8 bound never cuts a surrogate pair.
  let size = 0;
  let end = 0;
  for (const point of text) {
    size += encoder.encode(point).length;
    if (size > bytes) break;
    end += point.length;
  }
  return text.slice(0, end);
}
const jsonBytes = (value: unknown) =>
  encoder.encode(JSON.stringify(value)).length;
const positiveSeq = z.number().int().positive();
const streamingSchema = z.strictObject({ seq: positiveSeq, text: z.string() });
const characterSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  aliases: z.array(z.string()).optional(),
  description: z.string().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
});

export const sessionProjectionSchema = z.strictObject({
  version: z.literal(SESSION_BRIDGE_VERSION),
  phase: z.enum(["setup", "playing"]),
  turn: z.number().int().nonnegative(),
  executing: z.boolean(),
  messages: z
    .array(
      z.strictObject({
        seq: positiveSeq,
        role: z.enum(["user", "assistant"]),
        text: z.string(),
        truncated: z.literal(true).optional(),
      }),
    )
    .max(SESSION_BRIDGE_MAX_MESSAGES),
  streaming: streamingSchema.nullable(),
  pending: z
    .array(z.strictObject({ seq: positiveSeq, block: z.unknown() }))
    .max(SESSION_BRIDGE_MAX_PENDING),
  characters: z.array(characterSchema).max(SESSION_BRIDGE_MAX_CHARACTERS),
  slots: z.array(
    z.strictObject({
      slot: z.string(),
      key: z.string().optional(),
      value: z.unknown(),
    }),
  ),
});
type ProjectionShape = z.infer<typeof sessionProjectionSchema>;
type ReadonlyProjection<T> = T extends object
  ? { readonly [Key in keyof T]: ReadonlyProjection<T[Key]> }
  : T;
export type SessionProjection = ReadonlyProjection<ProjectionShape>;

export interface SessionProjectionInput {
  session: Pick<SessionRecord, "phase" | "completedPlayerTurns">;
  executing: boolean;
  messages: readonly StreamMessage[];
  /** Host-only identity map; only the assigned ordinals cross the port. */
  messageSeqs: ReadonlyMap<string, number>;
  submittedBlockIds: ReadonlySet<string>;
  streamingText: string | undefined;
  characters: readonly unknown[];
  slots: readonly { slot: string; key?: string; value: unknown }[];
}

export function visibleSessionMessages(
  messages: readonly StreamMessage[],
): readonly StreamMessage[] {
  return messages.filter(isVisibleSessionMessage);
}

function isVisibleSessionMessage(message: StreamMessage): boolean {
  return (
    (message.role === "assistant" && message.kind === "story") ||
    (message.role === "user" && !message.block)
  );
}

/**
 * Allocate positive ordinals on first observation, never from a window index.
 * Keep evicted IDs so loading their history restores the same identity. The
 * message array carries chronology; prepended history can have newer ordinals.
 */
export function createSessionMessageOrdinals() {
  const known = new Map<string, number>();
  const streaming = new Map<string, number>();
  let next = 1;
  return (messages: readonly StreamMessage[]): ReadonlyMap<string, number> => {
    const current = new Map<string, number>();
    for (const message of messages) {
      if (!isVisibleSessionMessage(message) && !message.block) continue;
      const stream = message.id.startsWith("stream_");
      const story = message.role === "assistant" && message.kind === "story";
      const streamKey =
        story && message.turnId && message.runtimeId
          ? JSON.stringify([message.turnId, message.runtimeId])
          : undefined;
      const seq =
        known.get(message.id) ??
        (!stream && streamKey ? streaming.get(streamKey) : undefined) ??
        next++;
      known.set(message.id, seq);
      current.set(message.id, seq);
      if (streamKey) {
        if (stream) streaming.set(streamKey, seq);
        else streaming.delete(streamKey);
      }
    }
    return current;
  };
}

export function buildSessionProjection(
  input: SessionProjectionInput,
): SessionProjection {
  const visible = visibleSessionMessages(input.messages);
  const messages: ProjectionShape["messages"] = [];
  let streaming: SessionProjection["streaming"] = null;
  let textBytes = 0;
  for (const message of visible) {
    // Missing ordinals fail the projection schema instead of reusing an index.
    const seq = input.messageSeqs.get(message.id) ?? 0;
    if (message.id.startsWith("stream_")) {
      streaming = {
        seq,
        text: boundedSessionText(
          input.streamingText ?? message.content,
          SESSION_BRIDGE_MAX_STREAM_BYTES,
        ),
      };
      continue;
    }
    const text = boundedSessionText(
      message.content,
      SESSION_BRIDGE_MAX_MESSAGE_BYTES,
    );
    messages.push({
      seq,
      role: message.role as "user" | "assistant",
      text,
      ...(text !== message.content ? { truncated: true as const } : {}),
    });
    textBytes += encoder.encode(text).length;
    while (
      messages.length > SESSION_BRIDGE_MAX_MESSAGES ||
      textBytes > SESSION_BRIDGE_MAX_TEXT_BYTES
    ) {
      const removed = messages.shift();
      if (removed) textBytes -= encoder.encode(removed.text).length;
    }
  }
  const pending: ProjectionShape["pending"] = [];
  const allMessages = [...input.messages];
  for (const message of input.messages) {
    if (pending.length >= SESSION_BRIDGE_MAX_PENDING) break;
    if (
      !isPendingInteractionMessage(
        message,
        allMessages,
        input.submittedBlockIds,
      )
    )
      continue;
    const block = stripHiddenKeys(message.block);
    pending.push({
      seq: input.messageSeqs.get(message.id) ?? 0,
      block:
        jsonBytes(block) <= SESSION_BRIDGE_MAX_BLOCK_BYTES
          ? block
          : { truncated: true },
    });
  }
  const characters: ProjectionShape["characters"] = [];
  for (const value of input.characters) {
    if (characters.length >= SESSION_BRIDGE_MAX_CHARACTERS) break;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    // Explicit allow list: no spread of a character or session record.
    const parsed = characterSchema.safeParse({
      id: record.id,
      name: record.name,
      type: record.type,
      ...(record.aliases !== undefined
        ? { aliases: stripHiddenKeys(record.aliases) }
        : {}),
      ...(record.description !== undefined
        ? { description: stripHiddenKeys(record.description) }
        : {}),
      ...(record.fields !== undefined
        ? { fields: stripHiddenKeys(record.fields) }
        : {}),
    });
    if (
      parsed.success &&
      jsonBytes(parsed.data) <= SESSION_BRIDGE_MAX_CHARACTER_BYTES
    )
      characters.push(parsed.data);
  }
  return {
    version: SESSION_BRIDGE_VERSION,
    phase: input.session.phase,
    turn: input.session.completedPlayerTurns,
    executing: input.executing,
    messages,
    streaming,
    pending,
    characters,
    slots: input.slots.map((entry) => ({
      slot: entry.slot,
      ...(entry.key !== undefined ? { key: entry.key } : {}),
      value: stripHiddenKeys(entry.value),
    })),
  };
}
