/**
 * Session store — manages game session state.
 *
 * Handles: world selection → session creation → SSE streaming → message accumulation
 */

import { useSyncExternalStore, useCallback } from "react";
import * as api from "@/services/api.js";
import { applyChanges, resetPluginData } from "./plugin-data-store.js";

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
};

// Re-export WorldRecord for components
export type { WorldRecord, PluginInfo } from "@/services/api.js";

const listeners = new Set<() => void>();
function notify() { for (const l of listeners) l(); }
function subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); }
function getSnapshot() { return state; }

function update(patch: Partial<SessionState>) {
  state = { ...state, ...patch };
  notify();
}

function addMessage(msg: GameMessage) {
  state = { ...state, messages: [...state.messages, msg] };
  notify();
}

function appendDelta(runtimeId: string, delta: string) {
  const msgs = [...state.messages];
  const idx = msgs.findLastIndex((m) => m.runtimeId === runtimeId && m.role === "assistant");
  if (idx >= 0) {
    msgs[idx] = { ...msgs[idx], content: msgs[idx].content + delta };
    state = { ...state, messages: msgs };
    notify();
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
        // Replace the streaming message with completed one
        const msgs = state.messages.filter((m) => m.runtimeId !== runtimeId || m.role !== "assistant");
        msgs.push({
          id: `msg-${Date.now()}`,
          role: "assistant",
          content,
          runtimeId,
          pluginId: data.pluginId as string,
          kind,
          timestamp: new Date().toISOString(),
        });
        update({ messages: msgs });
      }
      break;
    }
    case "interaction.requested": {
      const block = data.block as Record<string, unknown>;
      if (block) {
        addMessage({
          id: `block-${Date.now()}`,
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
        });
        // Create placeholder message for streaming
        addMessage({
          id: `stream-${runtimeId}`,
          role: "assistant",
          content: "",
          runtimeId,
          pluginId: data.pluginId as string,
          kind: "story",
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
    case "phase.changed": {
      const phase = data.phase as string;
      if (phase && state.session) {
        update({ session: { ...state.session, phase } });
      }
      break;
    }
    case "plugin-data.changed": {
      const pluginId = data.pluginId as string;
      const changes = data.changes as Array<{ namespace: string; key: string; value: unknown; operation: "set" | "delete" }>;
      if (pluginId && changes) applyChanges(pluginId, changes);
      break;
    }
  }
}

// ── SSE Stream Reader ────────────────────────────────────────────

async function readActionStream(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    let currentEventType = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const raw = line.slice(6);
        try {
          const data = JSON.parse(raw) as Record<string, unknown>;
          const eventType = currentEventType || (data.type as string) || "unknown";
          processSSEEvent(eventType, data.payload ? data.payload as Record<string, unknown> : data);
        } catch {
          // skip non-JSON lines
        }
        currentEventType = "";
      }
    }
  }
}

// ── Actions ──────────────────────────────────────────────────────

export async function boot() {
  try {
    const [worlds, plugins] = await Promise.all([
      api.listWorlds(),
      api.listPlugins(),
    ]);
    update({ phase: "world-select", worlds, plugins });
  } catch (e) {
    update({ error: (e as Error).message, phase: "world-select" });
  }
}

export function selectWorld(worldId: string) {
  const world = state.worlds.find((w) => w.id === worldId);
  if (world) {
    update({ selectedWorld: world, phase: "session-prep" });
  }
}

export function backToWorldSelect() {
  update({ selectedWorld: null, phase: "world-select" });
}

export async function startGame() {
  if (!state.selectedWorld) return;
  try {
    update({ error: null, executing: true });
    const session = await api.createSession(state.selectedWorld.id, state.plugins.map((p) => p.name));
    resetPluginData();
    update({ session, phase: "playing", messages: [], executionSteps: [] });

    // Start the game — post start_session action
    const response = await api.postAction({
      type: "start_session",
      sessionId: session.id,
      locale: "zh-CN",
    });
    await readActionStream(response);
  } catch (e) {
    update({ error: (e as Error).message, executing: false });
  }
}

export async function sendMessage(content: string) {
  if (!state.session || state.executing) return;

  // Add player message
  addMessage({
    id: `user-${Date.now()}`,
    role: "user",
    content,
    timestamp: new Date().toISOString(),
  });

  try {
    update({ executing: true, executionSteps: [] });
    const response = await api.postAction({
      type: "player_action",
      sessionId: state.session.id,
      playerMessage: content,
      locale: "zh-CN",
    });
    await readActionStream(response);
  } catch (e) {
    update({ error: (e as Error).message, executing: false });
  }
}

/**
 * Submit form/choice/confirmation inputs via the submit-inputs API.
 * This handles: narrativeTemplate filling, character creation, phase transition.
 * Then triggers the next turn via player_action.
 */
export async function submitFormInputs(payload: {
  turnId: string;
  interactionId: string;
  values: Record<string, unknown>;
}) {
  if (!state.session) return;

  try {
    // 1. Submit to submit-inputs API (creates character, transitions phase, fills narrative template)
    const result = await api.submitInputs(state.session.id, {
      turnId: payload.turnId,
      interactionId: payload.interactionId,
      values: payload.values,
    });

    // 2. Show the filled narrative as a player message (story text, not raw field data)
    if (result.filledNarrative) {
      addMessage({
        id: `input-${Date.now()}`,
        role: "user",
        content: result.filledNarrative,
        timestamp: new Date().toISOString(),
      });
    }

    // 3. Trigger next turn
    update({ executing: true, executionSteps: [] });
    const response = await api.postAction({
      type: "player_action",
      sessionId: state.session.id,
      playerMessage: result.filledNarrative || "(继续)",
      locale: "zh-CN",
    });
    await readActionStream(response);
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
  };
}
