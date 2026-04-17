/**
 * Session store — manages game session state.
 *
 * Handles: world selection → session creation → SSE streaming → message accumulation
 */

import { useSyncExternalStore, useCallback } from "react";
import type { SseEvent } from "@covel/api-client";
import * as api from "@/services/api.js";
import {
  applyChanges,
  resetPluginData,
  loadPluginData,
  getPluginNamespaceSnapshot,
} from "./plugin-data-store.js";
import { connectSSE } from "@/services/sse.js";

// ── Session-level SSE subscription ──────────────────────────────
//
// connectSSE opens an EventSource on /api/events/stream that delivers
// out-of-band events (plugin-data.changed, phase.changed, etc.) for the
// current session. Without this, we only get events that happen to be
// emitted inside an /api/actions request stream — events emitted from
// other tabs, background runtimes, or out-of-band tool calls were lost.
// See audits/2026-04-12-backend-webv2-framework-audit Finding w1.

let sseTeardown: (() => void) | null = null;

function closeSse(): void {
  if (sseTeardown) {
    sseTeardown();
    sseTeardown = null;
  }
}

function openSse(sessionId: string): void {
  closeSse();
  sseTeardown = connectSSE({
    sessionId,
    onEvent: (type, data) => {
      // The /api/events/stream envelope wraps the payload under .payload,
      // matching how /api/actions stream events are shaped. Pass the inner
      // payload to the same reducer so both code paths converge.
      const payload = data.payload
        ? {
          ...(data.payload as Record<string, unknown>),
          ...(data.turnId ? { turnId: data.turnId } : {}),
        }
        : (data as Record<string, unknown>);
      processSSEEvent(type, payload);
    },
  });
}

// ── URL Session ID ───────────────────────────────────────────────
//
// ?sid=xxx is the tab-local session identifier. Multiple tabs can open
// different sessions by having different ?sid params in the URL.

function getSidFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("sid");
}

function setSidInUrl(sid: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("sid", sid);
  history.replaceState(null, "", url.toString());
}

function clearSidFromUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("sid");
  history.replaceState(null, "", url.toString());
}

// ── LocalStorage Keys ───────────────────────────────────────────

const LS_SESSION_ID = "covel:sessionId";
const LS_WORLD_ID = "covel:worldId";

function saveSessionToStorage(sessionId: string, worldId: string): void {
  localStorage.setItem(LS_SESSION_ID, sessionId);
  localStorage.setItem(LS_WORLD_ID, worldId);
}

function clearSessionStorage(): void {
  localStorage.removeItem(LS_SESSION_ID);
  localStorage.removeItem(LS_WORLD_ID);
}

export function getSavedSession(): { sessionId: string; worldId: string } | null {
  const sessionId = localStorage.getItem(LS_SESSION_ID);
  const worldId = localStorage.getItem(LS_WORLD_ID);
  if (sessionId && worldId) return { sessionId, worldId };
  return null;
}

// ── Types ────────────────────────────────────────────────────────

export type AppPhase = "loading" | "world-select" | "session-prep" | "playing";

export interface GameMessage {
  id: string;
  role: "system" | "assistant" | "user";
  content: string;
  runtimeId?: string;
  pluginId?: string;
  turnId?: string;
  kind?: string;
  block?: Record<string, unknown>;
  timestamp: string;
}

export interface ExecutionStep {
  runtimeId: string;
  pluginId: string;
  status: "running" | "completed" | "failed";
  label?: string;
  durationMs?: number;
  turnId?: string;
}

export interface PendingInteractionDraft {
  id: string;
  turnId: string;
  interactionId: string;
  type: "form" | "choice" | "confirmation" | "suggestion";
  label: string;
  values: Record<string, unknown>;
  selectionGroup?: string;
  submitBehavior?: {
    echoFilledNarrative?: boolean;
    autoContinue?: boolean;
  };
}

interface SessionState {
  phase: AppPhase;
  worlds: api.WorldRecord[];
  selectedWorld: api.WorldRecord | null;
  session: api.SessionRecord | null;
  messages: GameMessage[];
  executing: boolean;
  executionSteps: ExecutionStep[];
  error: string | null;
  plugins: api.PluginInfo[];
  selectedPlugins: string[];
  pluginFlow: api.PluginFlowResponse | null;
  messageUiSpecs: api.UISlotEntry[];
  composerText: string;
  pendingInteractionDrafts: PendingInteractionDraft[];
  worldSessions: api.SessionRecord[];
}

// ── Store ────────────────────────────────────────────────────────

let state: SessionState = {
  phase: "loading",
  worlds: [],
  selectedWorld: null,
  session: null,
  messages: [],
  executing: false,
  executionSteps: [],
  error: null,
  plugins: [],
  selectedPlugins: [],
  pluginFlow: null,
  messageUiSpecs: [],
  composerText: "",
  pendingInteractionDrafts: [],
  worldSessions: [],
};

// Re-export types for components
export type { WorldRecord, PluginInfo, SessionRecord } from "@/services/api.js";

const listeners = new Set<() => void>();
function notify() { for (const l of listeners) l(); }
function subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); }
function getSnapshot() { return state; }

let clientMessageSeq = 0;
function nextClientId(prefix: string): string {
  clientMessageSeq += 1;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${clientMessageSeq}`;
}

function update(patch: Partial<SessionState>) {
  state = { ...state, ...patch };
  notify();
}

function addMessage(msg: GameMessage) {
  state = { ...state, messages: [...state.messages, msg] };
  notify();
}

export function setComposerText(composerText: string) {
  update({ composerText });
}

export function upsertPendingInteractionDraft(draft: PendingInteractionDraft) {
  const existing = state.pendingInteractionDrafts.filter((item) =>
    item.id !== draft.id &&
    !(draft.selectionGroup && item.turnId === draft.turnId && item.selectionGroup === draft.selectionGroup),
  );
  update({ pendingInteractionDrafts: [...existing, draft] });
}

export function removePendingInteractionDraft(id: string) {
  update({ pendingInteractionDrafts: state.pendingInteractionDrafts.filter((item) => item.id !== id) });
}

function clearPendingInteractionDrafts() {
  update({ pendingInteractionDrafts: [] });
}

function appendDelta(runtimeId: string, delta: string) {
  const msgs = [...state.messages];
  // Find the most recent streaming placeholder for this runtime. We
  // intentionally DO NOT require `content === ""` — after the first delta
  // the content is non-empty, and the filter would silently drop every
  // subsequent delta. Because messages are append-only, findLastIndex on
  // (runtimeId, kind) reliably finds the current turn's placeholder.
  const idx = msgs.findLastIndex((m) =>
    m.runtimeId === runtimeId &&
    m.role === "assistant" &&
    m.kind === "story",
  );
  if (idx >= 0) {
    msgs[idx] = { ...msgs[idx], content: msgs[idx].content + delta };
    state = { ...state, messages: msgs };
    notify();
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stripPrivateMessageKeys(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !key.startsWith("__")),
  );
}

function upsertPluginMessageSurface(pluginId: string): void {
  const uiEntry = state.messageUiSpecs.find((entry) => entry.pluginId === pluginId);
  if (!uiEntry || uiEntry.specs.length === 0) return;

  const namespaceState = getPluginNamespaceSnapshot(pluginId, "message");
  const turnId = typeof namespaceState.__turnId === "string" ? namespaceState.__turnId : "";
  if (!turnId) return;

  const blockState = stripPrivateMessageKeys(namespaceState);
  const messageId = `plugin-message:${pluginId}:${turnId}`;
  const block = {
    type: "plugin_message",
    data: {
      pluginId,
      specs: cloneJson(uiEntry.specs),
      state: cloneJson(blockState),
    },
    meta: {
      pluginId,
      turnId,
    },
  };

  const existingIndex = state.messages.findIndex((message) => message.id === messageId);
  if (existingIndex >= 0) {
    const messages = [...state.messages];
    messages[existingIndex] = {
      ...messages[existingIndex],
      block,
      timestamp: new Date().toISOString(),
    };
    update({ messages });
    return;
  }

  const nextMessage: GameMessage = {
    id: messageId,
    role: "assistant",
    content: "",
    pluginId,
    turnId,
    kind: "plugin-message",
    block,
    timestamp: new Date().toISOString(),
  };

  const anchorIndex = [...state.messages]
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.turnId === turnId && (message.kind === "story" || message.kind === "plugin-message"))
    .map(({ index }) => index)
    .at(-1);

  const messages = [...state.messages];
  if (anchorIndex == null) {
    messages.push(nextMessage);
  } else {
    messages.splice(anchorIndex + 1, 0, nextMessage);
  }
  update({ messages });
}

async function loadSessionUiSpecs(sessionId: string): Promise<void> {
  try {
    const specs = await api.fetchUiSpecs(sessionId);
    update({ messageUiSpecs: specs.message });
  } catch {
    update({ messageUiSpecs: [] });
  }
}

function updateStep(runtimeId: string, patch: Partial<ExecutionStep>) {
  const steps = [...state.executionSteps];
  const idx = steps.findIndex((s) => s.runtimeId === runtimeId);
  if (idx >= 0) {
    steps[idx] = { ...steps[idx], ...patch };
  } else {
    steps.push({ runtimeId, pluginId: patch.pluginId ?? "", status: "running", ...patch });
  }
  state = { ...state, executionSteps: steps };
  notify();
}

function mergeSelectedPlugins(
  plugins: api.PluginInfo[],
  currentSelection: string[],
): string[] {
  const available = new Set(plugins.map((plugin) => plugin.name));
  const next = new Set(currentSelection.filter((pluginId) => available.has(pluginId)));

  for (const plugin of plugins) {
    if (plugin.pluginType === "core-plugin") {
      next.add(plugin.name);
    }
  }

  return [...next];
}

async function loadPluginCatalog() {
  const [plugins, pluginFlow] = await Promise.all([
    api.listPlugins(),
    api.fetchPluginFlows(),
  ]);

  update({
    plugins,
    pluginFlow,
    selectedPlugins: mergeSelectedPlugins(plugins, state.selectedPlugins),
  });
}

// ── SSE Event Processing ─────────────────────────────────────────

function processSSEEvent(eventType: string, data: Record<string, unknown>) {
  switch (eventType) {
    case "narrative.delta": {
      const runtimeId = data.runtimeId as string;
      const delta = data.delta as string;
      if (runtimeId && delta) appendDelta(runtimeId, delta);
      break;
    }
    case "narrative.completed": {
      const content = data.content as string;
      const runtimeId = data.runtimeId as string;
      const kind = data.kind as string;
      if (content && kind === "story") {
        const msgs = [...state.messages];
        // Match by (runtimeId, kind) regardless of current content — the
        // placeholder may have accumulated partial text from streaming.
        // findLastIndex naturally picks the latest turn's placeholder.
        const placeholderIndex = msgs.findLastIndex((message) =>
          message.runtimeId === runtimeId &&
          message.role === "assistant" &&
          message.kind === "story",
        );
        const nextMessage: GameMessage = {
          id: nextClientId("msg"),
          role: "assistant",
          content,
          runtimeId,
          pluginId: data.pluginId as string,
          turnId: data.turnId as string | undefined,
          kind,
          timestamp: new Date().toISOString(),
        };
        if (placeholderIndex >= 0) {
          msgs[placeholderIndex] = {
            ...nextMessage,
            id: msgs[placeholderIndex].id,
          };
        } else {
          msgs.push(nextMessage);
        }
        update({ messages: msgs });
      }
      break;
    }
    case "interaction.requested": {
      const block = data.block as Record<string, unknown>;
      if (block) {
        addMessage({
          id: nextClientId("block"),
          role: "assistant",
          content: "",
          block,
          runtimeId: data.runtimeId as string,
          pluginId: data.pluginId as string,
          turnId: data.turnId as string ?? (block.meta as Record<string, unknown>)?.turnId as string,
          kind: "interaction",
          timestamp: new Date().toISOString(),
        });
      }
      break;
    }
    case "execution.started":
      update({ executing: true, executionSteps: [] });
      break;
    case "runtime.started": {
      const runtimeId = data.runtimeId as string ?? data.label as string;
      if (runtimeId) {
        updateStep(runtimeId, {
          status: "running",
          pluginId: data.pluginId as string,
          label: data.label as string,
          turnId: data.turnId as string | undefined,
        });
        // Create a streaming placeholder for every runtime. Non-story runtimes
        // won't receive any narrative.delta (useStreaming is gated on
        // outputKind==='story' in the backend), so their placeholders stay
        // empty and are filtered out by `m.content || m.block` in MessageList.
        // Keeping the placeholder for all runtimes preserves backward compat
        // with servers that don't yet emit `kind` on runtime.started.
        addMessage({
          id: nextClientId("stream"),
          role: "assistant",
          content: "",
          runtimeId,
          pluginId: data.pluginId as string,
          kind: "story",
          turnId: data.turnId as string | undefined,
          timestamp: new Date().toISOString(),
        });
      }
      break;
    }
    case "runtime.completed": {
      const runtimeId = data.runtimeId as string ?? data.label as string;
      if (runtimeId) {
        updateStep(runtimeId, {
          status: "completed",
          durationMs: data.durationMs as number,
        });
      }
      break;
    }
    case "runtime.failed": {
      const runtimeId = data.runtimeId as string;
      if (runtimeId) updateStep(runtimeId, { status: "failed" });
      break;
    }
    case "execution.completed":
      update({ executing: false });
      break;
    case "plugin-data.changed": {
      const pluginId = data.pluginId as string;
      const changes = data.changes as Array<{ namespace: string; key: string; value: unknown; operation: "set" | "delete" }>;
      if (pluginId && changes) {
        applyChanges(pluginId, changes);
        if (changes.some((change) => change.namespace === "message")) {
          upsertPluginMessageSurface(pluginId);
        }
      }
      break;
    }
  }
}

// ── SSE Stream Reader ────────────────────────────────────────────

/**
 * Drain an `@covel/api-client` action SSE stream and dispatch each
 * event into the session store. The api-client already JSON-parses
 * each event's `data` field, so we only need to normalise the legacy
 * "payload-or-data" envelope shape that the server emits.
 */
async function readActionStream(stream: AsyncIterable<SseEvent>) {
  for await (const evt of stream) {
    const data = (evt.data ?? {}) as Record<string, unknown>;
    const eventType = (data.type as string) || evt.type || "unknown";
    const payload = data.payload
      ? {
          ...(data.payload as Record<string, unknown>),
          ...(data.turnId ? { turnId: data.turnId } : {}),
        }
      : data;
    processSSEEvent(eventType, payload);
  }
}

// ── Actions ──────────────────────────────────────────────────────

export async function boot() {
  try {
    const worlds = await api.listWorlds();
    update({ worlds });
    await loadPluginCatalog();

    // 1. URL-based resume — tab-specific, takes priority over localStorage
    const urlSid = getSidFromUrl();
    if (urlSid) {
      try {
        await resumeSessionById(urlSid);
        return;
      } catch {
        clearSidFromUrl();
      }
    }

    // 2. localStorage fallback — last session across tabs
    const saved = getSavedSession();
    if (saved) {
      try {
        await resumeSession(saved.sessionId, saved.worldId);
        return;
      } catch {
        clearSessionStorage();
      }
    }

    update({ phase: "world-select" });
  } catch (e) {
    update({ error: (e as Error).message, phase: "world-select" });
  }
}

export async function refreshPluginCatalog() {
  try {
    await loadPluginCatalog();
  } catch (e) {
    update({ error: (e as Error).message });
  }
}

export function selectWorld(worldId: string) {
  const world = state.worlds.find((w) => w.id === worldId);
  if (world) {
    update({ selectedWorld: world, phase: "session-prep", worldSessions: [] });
    void loadWorldSessions(worldId);
  }
}

export function backToWorldSelect() {
  closeSse();
  clearSessionStorage();
  clearSidFromUrl();
  update({
    selectedWorld: null,
    session: null,
    messages: [],
    executionSteps: [],
    messageUiSpecs: [],
    worldSessions: [],
    composerText: "",
    pendingInteractionDrafts: [],
    phase: "world-select",
  });
}

export async function startGame() {
  if (!state.selectedWorld) return;
  try {
    clearSessionStorage();
    update({ error: null, executing: true });
    const session = await api.createSession(state.selectedWorld.id, state.selectedPlugins);
    resetPluginData();
    saveSessionToStorage(session.id, state.selectedWorld.id);
    setSidInUrl(session.id);
    update({
      session,
      phase: "playing",
      messages: [],
      executionSteps: [],
      messageUiSpecs: [],
      composerText: "",
      pendingInteractionDrafts: [],
    });
    openSse(session.id);
    await loadSessionUiSpecs(session.id);

    // Start the game — post start_session action
    const stream = api.postAction({
      type: "start_session",
      sessionId: session.id,
      locale: "zh-CN",
    });
    await readActionStream(stream);
  } catch (e) {
    update({ error: (e as Error).message, executing: false });
  }
}

export function togglePluginSelection(pluginName: string) {
  const plugin = state.plugins.find((item) => item.name === pluginName);
  if (!plugin || plugin.pluginType === "core-plugin") return;

  const selected = new Set(state.selectedPlugins);
  if (selected.has(pluginName)) {
    selected.delete(pluginName);
  } else {
    selected.add(pluginName);
  }

  // Core plugins stay present even if state was externally mutated.
  for (const item of state.plugins) {
    if (item.pluginType === "core-plugin") {
      selected.add(item.name);
    }
  }

  update({ selectedPlugins: [...selected] });
}

/**
 * Rebuild ExecutionStep[] from snapshot trace events (runtime.started / runtime.completed).
 * This allows historical runtime status to persist across session resume.
 */
function rebuildExecutionSteps(
  traceEvents: Array<{ type: string; turnId: string; payload: Record<string, unknown>; timestamp: string }>,
): ExecutionStep[] {
  const map = new Map<string, ExecutionStep>();

  for (const evt of traceEvents) {
    const payload = evt.payload;
    const runtimeId = payload.runtimeId as string | undefined;
    if (!runtimeId) continue;

    if (evt.type === "runtime.started") {
      map.set(`${evt.turnId}:${runtimeId}`, {
        runtimeId,
        pluginId: (payload.pluginId as string) ?? "",
        status: "running",
        label: (payload.pluginId as string) ?? runtimeId,
        turnId: evt.turnId,
      });
    } else if (evt.type === "runtime.completed") {
      const key = `${evt.turnId}:${runtimeId}`;
      const existing = map.get(key);
      if (existing) {
        map.set(key, {
          ...existing,
          status: (payload.status as string) === "failed" ? "failed" : "completed",
          durationMs: payload.durationMs as number | undefined,
        });
      } else {
        map.set(key, {
          runtimeId,
          pluginId: (payload.pluginId as string) ?? "",
          status: (payload.status as string) === "failed" ? "failed" : "completed",
          label: (payload.pluginId as string) ?? runtimeId,
          durationMs: payload.durationMs as number | undefined,
          turnId: evt.turnId,
        });
      }
    } else if (evt.type === "runtime.failed") {
      const key = `${evt.turnId}:${runtimeId}`;
      const existing = map.get(key);
      if (existing) {
        map.set(key, { ...existing, status: "failed" });
      }
    }
  }

  return Array.from(map.values());
}

export async function resumeSession(sessionId: string, worldId: string) {
  update({ error: null });

  const snapshot = await api.fetchSnapshot(sessionId);

  const nowIso = new Date().toISOString();
  const session: api.SessionRecord = {
    id: snapshot.session.id,
    worldId: snapshot.session.worldId ?? worldId,
    status: snapshot.session.status,
    turnCount: snapshot.session.turnCount ?? 0,
    preGameCompleted: snapshot.session.preGameCompleted ?? [],
    locale: snapshot.session.locale ?? "zh-CN",
    activePlugins: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const selectedWorld = state.worlds.find((w) => w.id === worldId) ?? null;

  // Convert snapshot messages to GameMessage format
  const messages: GameMessage[] = snapshot.messages.map((m) => ({
    id: m.id,
    role: m.role as GameMessage["role"],
    content: m.content,
    turnId: m.turnId,
    runtimeId: m.runtimeId,
    kind: m.kind,
    block: m.block as Record<string, unknown> | undefined,
    timestamp: m.createdAt,
  }));

  // Restore plugin data for active plugins
  resetPluginData();
  await loadSessionUiSpecs(sessionId);
  const activePlugins = snapshot.plugins.filter((p) => p.isActive);
  await Promise.all(
    activePlugins.map(async (plugin) => {
      try {
        const items = await api.fetchPluginData(sessionId, plugin.id);
        // Group by namespace and load
        const byNs = new Map<string, Array<{ key: string; value: unknown }>>();
        for (const item of items) {
          const arr = byNs.get(item.namespace) ?? [];
          arr.push({ key: item.key, value: item.value });
          byNs.set(item.namespace, arr);
        }
        for (const [ns, entries] of byNs) {
          loadPluginData(plugin.id, ns, entries);
        }
        if (byNs.has("message")) {
          upsertPluginMessageSurface(plugin.id);
        }
      } catch {
        // Non-critical: plugin data load failure shouldn't block restore
      }
    }),
  );

  // Rebuild execution steps from snapshot trace events so that historical
  // runtime status (which runtimes ran, how long each took) is preserved
  // across session resume for post-game analysis.
  const restoredSteps = rebuildExecutionSteps(snapshot.executionSteps);

  saveSessionToStorage(sessionId, worldId);
  setSidInUrl(sessionId);
  update({
    session,
    selectedWorld,
    messages,
    phase: "playing",
    executing: false,
    executionSteps: restoredSteps,
    messageUiSpecs: state.messageUiSpecs,
    composerText: "",
    pendingInteractionDrafts: [],
  });
  openSse(sessionId);
}

export async function resumeSessionById(sessionId: string): Promise<void> {
  const snapshot = await api.fetchSnapshot(sessionId);
  const worldId = snapshot.session.worldId ?? "";
  await resumeSession(sessionId, worldId);
}

export async function loadWorldSessions(worldId: string): Promise<void> {
  try {
    const all = await api.listSessions();
    const worldSessions = all
      .filter((s) => s.worldId === worldId)
      .sort((a, b) => {
        // Most recent first (by createdAt if available, else by id lexicographic desc)
        if (a.createdAt && b.createdAt) return b.createdAt.localeCompare(a.createdAt);
        return b.id.localeCompare(a.id);
      });
    update({ worldSessions });
  } catch {
    update({ worldSessions: [] });
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  await api.deleteSession(sessionId);
  update({ worldSessions: state.worldSessions.filter((s) => s.id !== sessionId) });
  // If deleting the currently active session, return to world select
  if (state.session?.id === sessionId) {
    backToWorldSelect();
  }
}

export async function sendMessage(content?: string) {
  if (!state.session || state.executing) return;

  const manualText = (content ?? state.composerText).trim();
  const pendingDrafts = [...state.pendingInteractionDrafts];
  if (!manualText && pendingDrafts.length === 0) return;

  const groupedSubmissions = new Map<string, PendingInteractionDraft[]>();
  for (const draft of pendingDrafts) {
    if (draft.type === "suggestion") continue;
    const group = groupedSubmissions.get(draft.turnId) ?? [];
    group.push(draft);
    groupedSubmissions.set(draft.turnId, group);
  }

  const suggestionLabels = pendingDrafts
    .filter((draft) => draft.type === "suggestion")
    .map((draft) => draft.label);

  const suggestionText = suggestionLabels.join("；");
  let visibleUserText = [suggestionText, manualText].filter(Boolean).join("\n");
  let autoContinue = false;
  const echoedFilledNarratives: string[] = [];

  try {
    for (const [turnId, drafts] of groupedSubmissions) {
      const result = await api.submitInputsBatch(state.session.id, {
        turnId,
        submissions: drafts.map((draft) => ({
          turnId: draft.turnId,
          interactionId: draft.interactionId,
          type: draft.type === "suggestion" ? "choice" : draft.type,
          values: draft.values,
        })),
      });

      for (const draft of drafts) {
        if (draft.submitBehavior?.autoContinue) autoContinue = true;
        const matched = result.results.find((item) => item.interactionId === draft.interactionId);
        if (!matched?.filledNarrative) continue;
        if (draft.submitBehavior?.echoFilledNarrative !== false) {
          echoedFilledNarratives.push(matched.filledNarrative);
        }
      }
    }

    if (!visibleUserText && echoedFilledNarratives.length > 0) {
      visibleUserText = echoedFilledNarratives.join("\n");
    }

    if (visibleUserText) {
      addMessage({
        id: nextClientId("user"),
        role: "user",
        content: visibleUserText,
        timestamp: new Date().toISOString(),
      });
    }

    update({ executing: true, composerText: "", pendingInteractionDrafts: [] });
    const stream = api.postAction({
      type: "send_message",
      sessionId: state.session.id,
      payload: { content: visibleUserText },
      locale: "zh-CN",
    });
    await readActionStream(stream);

    if (autoContinue) {
      update({ executing: true });
      const followup = api.postAction({
        type: "send_message",
        sessionId: state.session.id,
        payload: { content: "" },
        locale: "zh-CN",
      });
      await readActionStream(followup);
    }
  } catch (e) {
    update({ error: (e as Error).message, executing: false });
  }
}

/**
 * Submit form/choice/confirmation inputs via the submit-inputs API.
 * This records a pending submission draft, then the unified send path fills
 * narrative templates and advances the session through the next turn.
 */
export async function submitFormInputs(payload: {
  turnId: string;
  interactionId: string;
  values: Record<string, unknown>;
  label?: string;
  submitBehavior?: {
    echoFilledNarrative?: boolean;
    autoContinue?: boolean;
  };
}) {
  upsertPendingInteractionDraft({
    id: `${payload.turnId}:${payload.interactionId}`,
    turnId: payload.turnId,
    interactionId: payload.interactionId,
    type: "form",
    label: payload.label ?? payload.interactionId,
    values: payload.values,
    submitBehavior: payload.submitBehavior,
  });
}

// ── Retry ───────────────────────────────────────────────────────

/**
 * Re-execute the last turn. When `runtimeId` is given, retry from that
 * specific runtime downward; earlier runtimes replay from cache and emit
 * progress events without re-streaming their narrative. When omitted,
 * retry everything in the latest turn.
 *
 * The local message list drops messages belonging to the last turn so
 * the re-run stream repopulates them from scratch.
 */
export async function retryRuntime(runtimeId?: string) {
  if (!state.session || state.executing) return;

  const lastTurnId = [...state.messages]
    .reverse()
    .find((m) => m.turnId)?.turnId;

  if (lastTurnId) {
    const kept = state.messages.filter((m) => m.turnId !== lastTurnId);
    update({ messages: kept });
  }

  // Remove execution steps for the retried turn, keep history from earlier turns
  const retryKeptSteps = lastTurnId
    ? state.executionSteps.filter((s) => s.turnId !== lastTurnId)
    : state.executionSteps;
  update({ executing: true, executionSteps: retryKeptSteps, error: null });

  try {
    const stream = api.postAction({
      type: "retry_runtime",
      sessionId: state.session.id,
      payload: runtimeId ? { runtimeId } : {},
      locale: "zh-CN",
    });
    await readActionStream(stream);
  } catch (e) {
    update({ error: (e as Error).message, executing: false });
  }
}

// ── Hook ─────────────────────────────────────────────────────────

export function useSessionStore() {
  const s = useSyncExternalStore(subscribe, getSnapshot);
  return {
    ...s,
    boot: useCallback(boot, []),
    selectWorld: useCallback(selectWorld, []),
    backToWorldSelect: useCallback(backToWorldSelect, []),
    startGame: useCallback(startGame, []),
    sendMessage: useCallback(sendMessage, []),
    setComposerText: useCallback(setComposerText, []),
    removePendingInteractionDraft: useCallback(removePendingInteractionDraft, []),
    submitFormInputs: useCallback(submitFormInputs, []),
    resumeSession: useCallback(resumeSession, []),
    resumeSessionById: useCallback(resumeSessionById, []),
    loadWorldSessions: useCallback(loadWorldSessions, []),
    deleteSession: useCallback(deleteSession, []),
    togglePluginSelection: useCallback(togglePluginSelection, []),
    refreshPluginCatalog: useCallback(refreshPluginCatalog, []),
    upsertPendingInteractionDraft: useCallback(upsertPendingInteractionDraft, []),
    retryRuntime: useCallback(retryRuntime, []),
  };
}
