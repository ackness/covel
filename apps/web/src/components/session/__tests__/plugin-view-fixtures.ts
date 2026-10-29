import type { SessionPlugin } from "@/services/api.js";
import type { PluginViewEntry } from "../game-view/use-plugin-views.js";
import {
  buildSessionProjection,
  createSessionMessageOrdinals,
  type SessionProjectionInput,
} from "../session-bridge.js";
export const viewEntry: PluginViewEntry = {
  mode: "plugin:p:v",
  pluginId: "p",
  viewId: "v",
  label: "Reader",
  pluginName: "Probe",
  spec: {
    id: "v",
    label: { en: "Reader", zh: "阅读器" },
    webview: { html: "<p>reader</p>" },
    bridge: "session",
  },
};
export const pageViewEntry: PluginViewEntry = {
  ...viewEntry,
  spec: {
    ...viewEntry.spec,
    webview: { url: `/plugin-assets/p/${"a".repeat(32)}/index.html` },
  },
};
export const sessionPlugin: SessionPlugin = {
  id: "p",
  displayName: { en: "Probe", zh: "示例" },
  description: "Probe",
  kind: "plugin",
  source: "community",
  hostState: "installed",
  runtimeCount: 0,
  provides: [],
  requires: [],
  optional: [],
  conflicts: [],
  extensions: [],
  eventTopics: [],
  tags: [],
  runtimes: [],
  tools: [],
  userSettings: [],
  languages: { text: ["en", "zh"], instructions: ["en"] },
  serverCodeApproved: false,
  active: true,
  sessionState: "active",
  locked: false,
};
const projectionInput: Omit<SessionProjectionInput, "messageSeqs"> = {
  session: { phase: "playing", completedPlayerTurns: 1 },
  executing: false,
  messages: [
    {
      id: "story",
      role: "assistant",
      kind: "story",
      timestamp: "time",
      content: "Story available only after consent",
    },
  ],
  submittedBlockIds: new Set(),
  streamingText: undefined,
  characters: [],
  slots: [],
};
export const projection = buildSessionProjection({
  ...projectionInput,
  messageSeqs: createSessionMessageOrdinals()(projectionInput.messages),
});
