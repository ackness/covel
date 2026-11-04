import { z } from "zod";
import {
  resolveI18nText,
  currentCharacterOf,
  seatCharacterIds,
  uiSlotValueSchemas,
  type SessionActionKindsResponse,
  type Seat,
} from "@covel/shared";
import {
  publicInteraction,
  publicInteractionSchema,
} from "./session-bridge-interactions.js";
import type { SessionRecord } from "@/services/api.js";
import type { StreamMessage } from "@/stores/session-store.js";
import {
  draftStoryMessage,
  visibleDraftUnits,
  type LiveOutputPreference,
  type OutputDraft,
} from "@/stores/session-store/output-drafts.js";
import { isPendingInteractionMessage } from "./game-view/interaction-blocks.js";

export const SESSION_BRIDGE_VERSION = 4;
export const SESSION_BRIDGE_MAX_MESSAGES = 200;
export const SESSION_BRIDGE_MAX_MESSAGE_BYTES = 32 * 1024;
export const SESSION_BRIDGE_MAX_TEXT_BYTES = 256 * 1024;
export const SESSION_BRIDGE_MAX_CHARACTERS = 100;
export const SESSION_BRIDGE_MAX_CHARACTER_BYTES = 8 * 1024;
export const SESSION_BRIDGE_MAX_PENDING = 8;
export const SESSION_BRIDGE_MAX_DRAFTS = 4;
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
/** A story's display lines, the same ones the host stage reads one by one. */
const linesSchema = z
  .array(
    z.strictObject({
      kind: z.enum(["narration", "dialogue", "action"]),
      text: z.string(),
      speaker: z.string().optional(),
      speakerId: z.string().optional(),
    }),
  )
  .optional();
const characterSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  aliases: z.array(z.string()).optional(),
  description: z.string().optional(),
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
        lines: linesSchema,
        truncated: z.literal(true).optional(),
      }),
    )
    .max(SESSION_BRIDGE_MAX_MESSAGES),
  drafts: z
    .array(
      z.strictObject({
        state: z.enum(["writing", "revising", "accepted"]),
        text: z.string(),
        lines: linesSchema,
        truncated: z.literal(true).optional(),
      }),
    )
    .max(SESSION_BRIDGE_MAX_DRAFTS),
  pending: z
    .array(
      z.strictObject({
        seq: positiveSeq,
        interaction: publicInteractionSchema,
        handle: z.string().max(128).optional(),
      }),
    )
    .max(SESSION_BRIDGE_MAX_PENDING),
  input: z.strictObject({
    seats: z
      .array(
        z.strictObject({
          id: z.string(),
          role: z.enum(["player", "host", "spectator"]),
          characterIds: z.array(z.string()),
          currentCharacterId: z.string().optional(),
          allowed: z.array(z.string()),
        }),
      )
      .max(64),
    kinds: z
      .array(
        z.strictObject({
          kind: z.string(),
          label: z.string(),
          text: z.enum(["required", "optional", "none"]),
          actor: z.boolean(),
          fields: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .max(128),
  }),
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
  session: Pick<SessionRecord, "phase" | "completedPlayerTurns"> & {
    seats?: readonly Seat[];
  };
  actionKinds?: SessionActionKindsResponse | null;
  locale?: string;
  interactionHandle?: (message: StreamMessage) => string | undefined;
  executing: boolean;
  messages: readonly StreamMessage[];
  /** Stories still being written, shown as far as the player's preference allows. */
  drafts?: readonly OutputDraft[];
  liveOutput?: LiveOutputPreference;
  /** Host-only identity map; only the assigned ordinals cross the port. */
  messageSeqs: ReadonlyMap<string, number>;
  submittedBlockIds: ReadonlySet<string>;
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
  let next = 1;
  return (messages: readonly StreamMessage[]): ReadonlyMap<string, number> => {
    const current = new Map<string, number>();
    for (const message of messages) {
      if (!isVisibleSessionMessage(message) && !message.block) continue;
      const seq = known.get(message.id) ?? next++;
      known.set(message.id, seq);
      current.set(message.id, seq);
    }
    return current;
  };
}

export function buildSessionProjection(
  input: SessionProjectionInput,
): SessionProjection {
  const visible = visibleSessionMessages(input.messages);
  const messages: ProjectionShape["messages"] = [];
  let textBytes = 0;
  for (const message of visible) {
    // Missing ordinals fail the projection schema instead of reusing an index.
    const seq = input.messageSeqs.get(message.id) ?? 0;
    const text = boundedSessionText(
      message.content,
      SESSION_BRIDGE_MAX_MESSAGE_BYTES,
    );
    const lines = text === message.content ? publicLines(message) : undefined;
    messages.push({
      seq,
      role: message.role as "user" | "assistant",
      text,
      ...(lines ? { lines } : {}),
      ...(text !== message.content ? { truncated: true as const } : {}),
    });
    textBytes += messageBytes(text, lines);
    while (
      messages.length > SESSION_BRIDGE_MAX_MESSAGES ||
      textBytes > SESSION_BRIDGE_MAX_TEXT_BYTES
    ) {
      const removed = messages.shift();
      if (removed) textBytes -= messageBytes(removed.text, removed.lines);
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
    let interaction = publicInteraction(message.block!);
    if (jsonBytes(interaction) > SESSION_BRIDGE_MAX_BLOCK_BYTES)
      interaction = { type: "unavailable" };
    const handle =
      interaction.type !== "unavailable"
        ? input.interactionHandle?.(message)
        : undefined;
    pending.push({
      seq: input.messageSeqs.get(message.id) ?? 0,
      interaction,
      ...(handle ? { handle } : {}),
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
    drafts: publicDrafts(input),
    pending,
    input: publicActionInput(input, characters),
    characters,
    slots: input.slots.flatMap((entry) => {
      const schema =
        uiSlotValueSchemas[entry.slot as keyof typeof uiSlotValueSchemas];
      if (!schema) return [];
      const parsed = schema.safeParse(stripHiddenKeys(entry.value));
      if (
        !parsed.success ||
        jsonBytes(parsed.data) > SESSION_BRIDGE_MAX_BLOCK_BYTES
      )
        return [];
      return [
        {
          slot: entry.slot,
          ...(entry.key !== undefined ? { key: entry.key } : {}),
          value: publicSlotValue(stripHiddenKeys(parsed.data)),
        },
      ];
    }),
  };
}

type PublicLines = NonNullable<ProjectionShape["messages"][number]["lines"]>;

/**
 * A story's segments as display lines, only when they spell out its text
 * exactly and fit the per-message bound; a page splits other text itself.
 */
function publicLines(
  message: Pick<StreamMessage, "content" | "segments">,
): PublicLines | undefined {
  const segments = message.segments;
  if (
    !segments?.length ||
    segments.map((segment) => segment.text).join("\n\n") !== message.content
  )
    return undefined;
  const lines = segments.map((segment) => ({
    kind: segment.kind,
    text: segment.text,
    ...(segment.speaker ? { speaker: segment.speaker } : {}),
    ...(segment.speakerId ? { speakerId: segment.speakerId } : {}),
  }));
  return jsonBytes(lines) <= SESSION_BRIDGE_MAX_MESSAGE_BYTES * 2
    ? lines
    : undefined;
}
const messageBytes = (text: string, lines: PublicLines | undefined) =>
  encoder.encode(text).length + (lines ? jsonBytes(lines) : 0);

/**
 * Story text before its commit, never its turn, runtime or plugin. A player
 * who waits for the commit sees none, so neither does their page.
 */
function publicDrafts(
  input: SessionProjectionInput,
): ProjectionShape["drafts"] {
  const preference = input.liveOutput ?? "units";
  const drafts: ProjectionShape["drafts"] = [];
  if (preference === "committed") return drafts;
  for (const draft of input.drafts ?? []) {
    if (drafts.length >= SESSION_BRIDGE_MAX_DRAFTS) break;
    const units = visibleDraftUnits(draft, preference);
    if (!units && !draft.revising) continue;
    const message = draftStoryMessage(draft, units ?? []);
    const text = boundedSessionText(
      message.content,
      SESSION_BRIDGE_MAX_MESSAGE_BYTES,
    );
    const lines = text === message.content ? publicLines(message) : undefined;
    drafts.push({
      state: draft.revising
        ? "revising"
        : draft.accepted
          ? "accepted"
          : "writing",
      text,
      ...(lines ? { lines } : {}),
      ...(text !== message.content ? { truncated: true as const } : {}),
    });
  }
  return drafts;
}

/** A small display vocabulary from an action field schema, never executable validation. */
function publicFields(
  value: unknown,
  depth = 0,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 4)
    return;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of [
    "type",
    "title",
    "description",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "multipleOf",
  ]) {
    const item = source[key];
    if (
      typeof item === "string" ||
      (typeof item === "number" && Number.isFinite(item))
    )
      out[key] = item;
  }
  if (Array.isArray(source.enum))
    out.enum = source.enum
      .filter(
        (item) =>
          item === null ||
          ["string", "number", "boolean"].includes(typeof item),
      )
      .slice(0, 128);
  if (Array.isArray(source.required))
    out.required = source.required
      .filter((item) => typeof item === "string")
      .slice(0, 64);
  if (source.properties && typeof source.properties === "object")
    out.properties = Object.fromEntries(
      Object.entries(source.properties)
        .slice(0, 64)
        .flatMap(([key, item]) => {
          const field = publicFields(item, depth + 1);
          return field && !key.startsWith("_") ? [[key, field]] : [];
        }),
    );
  const items = publicFields(source.items, depth + 1);
  if (items) out.items = items;
  return jsonBytes(out) <= SESSION_BRIDGE_MAX_BLOCK_BYTES ? out : undefined;
}
function publicActionInput(
  input: SessionProjectionInput,
  characters: ProjectionShape["characters"],
): ProjectionShape["input"] {
  const all = input.session.seats ?? [];
  const seats = all
    .filter((seat) => seat.controller === "human")
    .slice(0, 64)
    .map((seat) => {
      const current = currentCharacterOf(seat, characters, all);
      const catalogue = input.actionKinds?.seats.find(
        (item) =>
          item.seatId === seat.id &&
          item.role === seat.role &&
          item.controller === "human",
      );
      return {
        id: seat.id,
        role: seat.role,
        characterIds: seatCharacterIds(seat, characters, all),
        ...(current ? { currentCharacterId: current.id } : {}),
        allowed: [...(catalogue?.allowed ?? [])].filter((kind) =>
          input.actionKinds?.kinds.some(
            (item) =>
              item.kind === kind &&
              item.roles.includes(seat.role) &&
              (!item.actor || current),
          ),
        ),
      };
    });
  const allowed = new Set(seats.flatMap((seat) => seat.allowed));
  return {
    seats,
    kinds: (input.actionKinds?.kinds ?? [])
      .filter((item) => allowed.has(item.kind))
      .slice(0, 128)
      .map((item) => {
        const fields = publicFields(item.fieldsSchema);
        return {
          kind: item.kind,
          label:
            resolveI18nText(item.display.label, input.locale ?? "en-US") ??
            item.kind,
          text: item.text,
          actor: item.actor,
          ...(fields ? { fields } : {}),
        };
      }),
  };
}

// Media references retain only their opaque public identity, never provider or
// filesystem metadata attached by a generator.
function publicSlotValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicSlotValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id === "string" &&
    /^[a-f0-9]{64}$/.test(record.id) &&
    typeof record.mime === "string" &&
    typeof record.size === "number"
  )
    return { id: record.id, mime: record.mime, size: record.size };
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, publicSlotValue(item)]),
  );
}
