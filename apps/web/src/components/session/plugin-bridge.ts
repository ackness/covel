import { z } from "zod";
import {
  PLUGIN_FRAME_CSP,
  PLUGIN_BRIDGE_SCRIPT,
  SESSION_BRIDGE_MAX_REQUEST_BYTES,
  SESSION_BRIDGE_REQUEST_BUDGET,
  sessionBridgeOutcomeSchema,
} from "@covel/shared";

/**
 * The plugin's document as the frame host (`public/plugin-frame.html`) loads
 * it: the bridge script, then the plugin's HTML. The frame host's policy is
 * inherited; the copy here keeps the document closed if it is ever rendered
 * somewhere else.
 */
export function pluginFrameDocument(html: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${PLUGIN_FRAME_CSP}"><script>${PLUGIN_BRIDGE_SCRIPT}</script>${html}`;
}

/** A message that can be answered: anything else from the frame is dropped. */
const actionEnvelope = z.looseObject({
  type: z.literal("action"),
  id: z.string().min(1).max(80),
});
const actionRequest = z.strictObject({
  type: z.literal("action"),
  id: z.string().min(1).max(80),
  action: z.string().min(1).max(120),
  params: z.record(z.string(), z.unknown()),
});

/** Fixed text returned when a plugin UI action fails or returns an invalid outcome. */
const PLUGIN_UI_ACTION_FAILED = "Plugin UI action failed";

/** Requests one frame may have in progress; more are dropped unanswered. */
const MAX_IN_FLIGHT = 8;

/** Maximum UTF-8 JSON bytes allowed for a non-session webview action result. */
export const PANEL_BRIDGE_MAX_RESULT_BYTES = 32 * 1024;
const PANEL_BRIDGE_MAX_STRING_BYTES = 4 * 1024;
const PANEL_BRIDGE_MAX_DEPTH = 8;
const PANEL_BRIDGE_MAX_NODES = 2048;

const PANEL_BRIDGE_HIDDEN_KEYS = new Set([
  "hidden",
  "concealed",
  "turnId",
  "requestId",
  "runtimeId",
  "sessionId",
  "jobId",
  "eventId",
  "approvalId",
  "timestamp",
  "createdAt",
  "updatedAt",
  "uuid",
  "stack",
  "trace",
  "cause",
  "error",
  "abortReason",
  "environment",
  "runtimeResults",
  "deferredJobs",
  "providerContinuation",
  "authorization",
  "token",
  "apiKey",
  "secret",
  "password",
  "pending",
]);

const panelBridgeStatusSchema = z.enum([
  "ok",
  "accepted",
  "committed",
  "rejected",
  "failed",
  "skipped",
  "unavailable",
]);

/**
 * Bounded public outcome envelope for non-session plugin webviews.
 * Rejects raw PluginRpcResponse internals, arbitrary error strings, stack
 * traces and unrecognized fields.
 */
export const panelBridgeOutcomeSchema = z.strictObject({
  ok: z.boolean().optional(),
  status: panelBridgeStatusSchema,
  code: sessionBridgeOutcomeSchema.shape.code,
  issues: sessionBridgeOutcomeSchema.shape.issues,
  data: z.unknown().optional(),
  error: z.literal(PLUGIN_UI_ACTION_FAILED).optional(),
});
export type PanelBridgeOutcome = z.infer<typeof panelBridgeOutcomeSchema>;

const textEncoder = new TextEncoder();

function utf8ByteLength(text: string): number {
  return textEncoder.encode(text).length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeJsonValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  budget: { count: number },
): unknown {
  if (depth > PANEL_BRIDGE_MAX_DEPTH) {
    throw new Error("Plugin UI result exceeds maximum depth");
  }
  if (++budget.count > PANEL_BRIDGE_MAX_NODES) {
    throw new Error("Plugin UI result exceeds node limit");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Plugin UI result must be finite JSON");
    }
    return value;
  }
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("Circular plugin UI result");
    seen.add(value);
    try {
      return value.map((item) =>
        item === undefined
          ? null
          : sanitizeJsonValue(item, depth + 1, seen, budget),
      );
    } finally {
      seen.delete(value);
    }
  }
  if (!isPlainObject(value)) {
    throw new Error("Plugin UI result must contain plain JSON values");
  }
  if (seen.has(value)) throw new Error("Circular plugin UI result");
  seen.add(value);
  try {
    const entries: [string, unknown][] = [];
    for (const [key, item] of Object.entries(value)) {
      if (
        item === undefined ||
        key.startsWith("_") ||
        PANEL_BRIDGE_HIDDEN_KEYS.has(key)
      ) {
        continue;
      }
      entries.push([key, sanitizeJsonValue(item, depth + 1, seen, budget)]);
    }
    return Object.fromEntries(entries);
  } finally {
    seen.delete(value);
  }
}

/**
 * Clone a bounded, sanitized JSON payload for a non-session webview's `data`
 * field, stripping hidden/internal/error/credential keys and enforcing depth
 * and UTF-8 byte bounds.
 */
export function sanitizePanelBridgeData(value: unknown): unknown {
  const sanitized = sanitizeJsonValue(value, 0, new WeakSet(), { count: 0 });
  const encoded = JSON.stringify(sanitized);
  if (
    encoded === undefined ||
    utf8ByteLength(encoded) > PANEL_BRIDGE_MAX_RESULT_BYTES
  ) {
    throw new Error("Plugin UI result exceeds size limit");
  }
  return sanitized;
}

/**
 * Validate and bound a non-session webview handler outcome before it crosses
 * the MessagePort.
 */
export function serializePanelBridgeOutcome(value: unknown): unknown {
  if (value === undefined || value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid public outcome");
    return value;
  }
  if (typeof value === "string") {
    if (utf8ByteLength(value) > PANEL_BRIDGE_MAX_STRING_BYTES) {
      throw new Error("Invalid public outcome");
    }
    return value;
  }
  if (!isPlainObject(value)) {
    throw new Error("Invalid public outcome");
  }
  const parsed = panelBridgeOutcomeSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid public outcome");
  }
  const { data: rawData, ...rest } = parsed.data;
  const outcome: PanelBridgeOutcome =
    rawData !== undefined
      ? { ...rest, data: sanitizePanelBridgeData(rawData) }
      : rest;
  if (utf8ByteLength(JSON.stringify(outcome)) > PANEL_BRIDGE_MAX_RESULT_BYTES) {
    throw new Error("Invalid public outcome");
  }
  return outcome;
}

export type PluginBridgeHandler = (params: Record<string, unknown>) => unknown;

export interface PluginBridgeHost {
  state: Readonly<Record<string, unknown>>;
  locked: boolean;
  /** Session pages validate every outgoing result and own their capability gates. */
  sessionPage?: boolean;
  isCurrent?: () => boolean;
  handlers: Readonly<Record<string, PluginBridgeHandler>>;
}

export interface PluginBridge {
  pushState(state: Readonly<Record<string, unknown>>): void;
  ping(id: number): void;
  close(): void;
}

/**
 * Connect the app to the plugin document in one frame.
 *
 * The app listens on no window `message` event: the only channel is a
 * `MessagePort` whose other end is transferred to `target`, the frame's own
 * `contentWindow`, so no other window can address the bridge. What arrives on
 * the port is plugin-controlled input. It can name one of the handlers the
 * host offers and nothing else; a failure is answered with a fixed text, so
 * a server error or a credential in it never reaches plugin HTML.
 */
export function connectPluginBridge(
  target: Pick<Window, "postMessage">,
  html: string | undefined,
  host: () => PluginBridgeHost,
  options?: {
    onReady?: () => void;
    onPageError?: () => void;
    onPong?: (id: number) => void;
  },
): PluginBridge {
  const channel = new MessageChannel();
  const port = channel.port1;
  const inFlight = new Set<string>();
  const seen = new Set<string>();
  let closed = false;
  const active = () => !closed && (host().isCurrent?.() ?? true);
  const reply = (message: unknown) => {
    if (active()) port.postMessage(message);
  };
  const failure = (id: string) =>
    reply({ type: "result", id, error: PLUGIN_UI_ACTION_FAILED });
  port.onmessage = async ({ data }: MessageEvent<unknown>) => {
    if (!active()) return;
    if (data && typeof data === "object" && "type" in data) {
      if (data.type === "page-error") {
        options?.onPageError?.();
        return;
      }
      if (data.type === "pong") {
        const parsed = z
          .strictObject({
            type: z.literal("pong"),
            id: z.number().int().positive().safe(),
          })
          .safeParse(data);
        if (parsed.success) options?.onPong?.(parsed.data.id);
        return;
      }
    }
    if (
      data &&
      typeof data === "object" &&
      "type" in data &&
      data.type === "ready"
    ) {
      options?.onReady?.();
      return;
    }
    const envelope = actionEnvelope.safeParse(data);
    if (!envelope.success) return;
    const { id } = envelope.data;
    if (inFlight.has(id)) {
      failure(id);
      return;
    }
    if (seen.has(id) || seen.size >= SESSION_BRIDGE_REQUEST_BUDGET) {
      failure(id);
      return;
    }
    seen.add(id);
    if (inFlight.size >= MAX_IN_FLIGHT) return;
    inFlight.add(id);
    try {
      const bytes = utf8ByteLength(JSON.stringify(data));
      if (bytes > SESSION_BRIDGE_MAX_REQUEST_BYTES)
        throw new Error("Request too large");
      const request = actionRequest.safeParse(data);
      if (!request.success) throw new Error("Invalid plugin UI action");
      const { locked, handlers, sessionPage } = host();
      const handler = Object.hasOwn(handlers, request.data.action)
        ? handlers[request.data.action]
        : undefined;
      if ((!sessionPage && locked) || !handler || !active())
        throw new Error("Plugin UI action is unavailable");
      const value = await handler(request.data.params);
      if (sessionPage) {
        const parsed = sessionBridgeOutcomeSchema.safeParse(value);
        if (!parsed.success) throw new Error("Invalid public outcome");
        reply({ type: "result", id, value: parsed.data });
      } else {
        reply({
          type: "result",
          id,
          value: serializePanelBridgeOutcome(value),
        });
      }
    } catch {
      failure(id);
    } finally {
      inFlight.delete(id);
    }
  };
  // The frame is an opaque origin, which no target origin but "*" matches.
  // The message carries the plugin's own HTML and nothing else.
  target.postMessage(
    html === undefined
      ? { type: "covel:connect" }
      : { type: "covel:connect", document: pluginFrameDocument(html) },
    "*",
    [channel.port2],
  );
  reply({ type: "state", value: host().state });
  return {
    ping: (id) => reply({ type: "ping", id }),
    pushState: (state) => reply({ type: "state", value: state }),
    close: () => {
      if (closed) return;
      port.postMessage({ type: "closed" });
      closed = true;
      port.onmessage = null;
      port.close();
      inFlight.clear();
      seen.clear();
    },
  };
}
