import { startTransition, useEffect, useRef, useState } from "react";

import {
  createArchive,
  createSession,
  createWorld,
  executeCommand,
  listArchives,
  listCommands,
  listMessages,
  listPackageState,
  listPackages,
  listPresets,
  listSessions,
  listTraces,
  listWorkflowSnapshots,
  listWorlds,
  restoreArchive,
  sendMessage,
  submitBlockResponse,
  updatePreset,
  updateSession
} from "./api.js";
import { useI18n, type Locale } from "./i18n.js";
import {
  autocompleteSlashCommand,
  resolveSlashCommandQuery,
  resolveSlashCommandSuggestions
} from "./slash-command.js";
import { applySseEvent, createInitialWorkspaceState, timelineFromMessages } from "./state.js";
import type {
  ArchiveRecord,
  CommandSummary,
  PackageStateRecord,
  PresetSummary,
  SessionRecord,
  TraceRecord,
  WorkflowSnapshotRecord,
  WorldRecord,
  WorkspaceState
} from "./types.js";
import { STORY_NARRATION_TASK } from "../../../modules/domain/src/index.js";

const STARTER_WORLD_BY_LOCALE: Record<Locale, {
  name: string;
  description: string;
  opener: string;
}> = {
  "zh-CN": {
    name: "雾港十三号",
    description: "风暴带边缘的浮桥城，灯塔靠鲸油与旧算法维持夜航，帮派、船团与失控遗物在潮雾里彼此试探。",
    opener: "我刚抵达雾港十三号的北栈桥，先告诉我眼前最值得注意的三件事。"
  },
  en: {
    name: "Mistharbor XIII",
    description: "A storm-belt port of floating piers where the lighthouse runs on whale oil and obsolete code, and every faction watches the fog for contraband relics.",
    opener: "I have just arrived at the north pier of Mistharbor XIII. Tell me the three most important things in front of me."
  }
};

const WORKBENCH_PACKAGE_STATE_QUERIES = [
  {
    packageName: "core-guide",
    collection: "guide_state"
  }
] as const;

function createOptimisticUserMessage(content: string) {
  return {
    kind: "message" as const,
    id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role: "user" as const,
    content,
    streaming: false
  };
}

function createOpeningPrompt(worldName: string, locale: Locale): string {
  return locale === "en"
    ? `I have just entered ${worldName}. Sketch the opening scene in three sharp details.`
    : `我刚进入${worldName}，请先用三个清晰细节铺开开场场景。`;
}

function resolveSessionPresetId(session: SessionRecord | null, defaultPresetId: string): string {
  return session?.taskBindings?.[STORY_NARRATION_TASK] ?? session?.presetId ?? defaultPresetId;
}

function mergePresetSummaries(current: PresetSummary[], updated: PresetSummary): PresetSummary[] {
  const next = current.some((preset) => preset.id === updated.id)
    ? current.map((preset) => {
        if (preset.id === updated.id) {
          return {
            ...preset,
            ...updated
          };
        }

        if (updated.isDefault && preset.isDefault) {
          return {
            ...preset,
            isDefault: false
          };
        }

        return preset;
      })
    : [...current, updated];

  return updated.isDefault
    ? next.map((preset) => preset.id === updated.id ? preset : { ...preset, isDefault: false })
    : next;
}

function resolveSelectablePresetId(presets: PresetSummary[], preferredId: string): string {
  if (preferredId && presets.some((preset) => preset.id === preferredId && preset.enabled)) {
    return preferredId;
  }

  return presets.find((preset) => preset.isDefault && preset.enabled)?.id
    ?? presets.find((preset) => preset.enabled)?.id
    ?? preferredId;
}

function buildGuideCommand(topic: string): string {
  const trimmed = topic.trim();
  return trimmed.length > 0 ? `/guide ${JSON.stringify(trimmed)}` : "/guide";
}

export function useWorkbenchController() {
  const { locale, setLocale, t } = useI18n();
  const [worlds, setWorlds] = useState<WorldRecord[]>([]);
  const [commands, setCommands] = useState<CommandSummary[]>([]);
  const [packages, setPackages] = useState<Array<{ name: string; enabled: boolean }>>([]);
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [selectedWorldId, setSelectedWorldId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [selectedSession, setSelectedSession] = useState<SessionRecord | null>(null);
  const [archives, setArchives] = useState<ArchiveRecord[]>([]);
  const [guideStateRecords, setGuideStateRecords] = useState<PackageStateRecord[]>([]);
  const [traceEntries, setTraceEntries] = useState<TraceRecord[]>([]);
  const [workflowSnapshots, setWorkflowSnapshots] = useState<WorkflowSnapshotRecord[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceState>(createInitialWorkspaceState());
  const [composer, setComposer] = useState("");
  const [worldName, setWorldName] = useState("");
  const [worldDescription, setWorldDescription] = useState("");
  const [newSessionPresetId, setNewSessionPresetId] = useState("");
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [dismissedSlashQuery, setDismissedSlashQuery] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "streaming">("idle");

  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const composerFormRef = useRef<HTMLFormElement | null>(null);
  const pendingBlockRef = useRef<HTMLElement | null>(null);
  const selectedSessionIdRef = useRef<string | null>(null);
  const skipNextSessionLoadRef = useRef<string | null>(null);

  const starterWorld = STARTER_WORLD_BY_LOCALE[locale];
  const selectedWorld = worlds.find((world) => world.id === selectedWorldId) ?? null;
  const defaultPresetId = presets.find((preset) => preset.isDefault)?.id ?? presets[0]?.id ?? "";
  const activeSessionPresetId = resolveSessionPresetId(selectedSession, defaultPresetId);
  const canSend = Boolean(selectedSession) && composer.trim().length > 0 && status !== "streaming";
  const enabledPresets = presets.filter((preset) => preset.enabled);
  const activeSessionPreset = presets.find((preset) => preset.id === activeSessionPresetId) ?? null;
  const sessionPresetOptions = activeSessionPreset && !enabledPresets.some((preset) => preset.id === activeSessionPreset.id)
    ? [activeSessionPreset, ...enabledPresets]
    : enabledPresets;
  const slashCommandQuery = resolveSlashCommandQuery(composer);
  const slashSuggestions = resolveSlashCommandSuggestions(composer, commands);
  const normalizedSlashSelectedIndex = Math.min(
    slashSelectedIndex,
    Math.max(slashSuggestions.length - 1, 0)
  );
  const activeSlashCommand = slashSuggestions[normalizedSlashSelectedIndex] ?? null;
  const showSlashMenu =
    Boolean(selectedSession) &&
    slashCommandQuery !== null &&
    slashSuggestions.length > 0 &&
    dismissedSlashQuery !== slashCommandQuery;
  const workbenchTitle = selectedWorld?.name ?? starterWorld.name;
  const workbenchDescription = selectedWorld?.description ?? starterWorld.description;
  const emptyTimelinePrompt = createOpeningPrompt(workbenchTitle, locale);
  const activeSessionPresetName = presets.find((preset) => preset.id === activeSessionPresetId)?.name
    ?? t("app.sessionPresetUnbound");

  useEffect(() => {
    selectedSessionIdRef.current = selectedSession?.id ?? null;
  }, [selectedSession?.id]);

  useEffect(() => {
    void loadInitialData();
  }, []);

  useEffect(() => {
    if (!selectedWorldId) {
      return;
    }

    void loadSessionsForWorld(selectedWorldId);
  }, [selectedWorldId]);

  useEffect(() => {
    if (!selectedSession) {
      return;
    }

    if (skipNextSessionLoadRef.current === selectedSession.id) {
      skipNextSessionLoadRef.current = null;
      return;
    }

    void loadSessionData(selectedSession.id);
  }, [selectedSession?.id]);

  useEffect(() => {
    if (!workspace.lastTraceId) {
      setTraceEntries([]);
      return;
    }

    void loadTraceEntries(workspace.lastTraceId);
  }, [workspace.lastTraceId]);

  useEffect(() => {
    setSlashSelectedIndex(0);
    if (slashCommandQuery !== dismissedSlashQuery) {
      setDismissedSlashQuery(null);
    }
  }, [slashCommandQuery, dismissedSlashQuery]);

  useEffect(() => {
    const target = workspace.pendingBlock ? pendingBlockRef.current : composerFormRef.current;
    if (!target) {
      return;
    }

    window.requestAnimationFrame(() => {
      target.scrollIntoView?.({
        block: "nearest",
        behavior: "smooth"
      });
    });
  }, [workspace.pendingBlock?.id, workspace.timeline.length]);

  async function loadInitialData() {
    const [loadedWorlds, loadedCommands, loadedPackages, loadedPresets] = await Promise.all([
      listWorlds(),
      listCommands(),
      listPackages(),
      listPresets()
    ]);

    startTransition(() => {
      setWorlds(loadedWorlds);
      setCommands(loadedCommands);
      setPackages(loadedPackages);
      setPresets(loadedPresets);
      setNewSessionPresetId((current) => {
        if (current) {
          return current;
        }

        return loadedPresets.find((preset) => preset.isDefault)?.id ?? loadedPresets[0]?.id ?? "";
      });
      setSelectedWorldId((current) => current ?? loadedWorlds[0]?.id ?? null);
    });
  }

  async function loadSessionsForWorld(worldId: string) {
    const loadedSessions = await listSessions(worldId);
    startTransition(() => {
      setSessions(loadedSessions);
      setSelectedSession((current) => {
        if (current && loadedSessions.some((session) => session.id === current.id)) {
          return current;
        }

        return loadedSessions[0] ?? null;
      });
      if (loadedSessions.length === 0) {
        setWorkspace(createInitialWorkspaceState());
        setArchives([]);
        setGuideStateRecords([]);
        setTraceEntries([]);
        setWorkflowSnapshots([]);
      }
    });
  }

  async function loadSessionData(sessionId: string) {
    const nextData = await fetchSessionData(sessionId);
    if (selectedSessionIdRef.current !== sessionId) {
      return;
    }

    startTransition(() => {
      setWorkspace({
        ...createInitialWorkspaceState(),
        timeline: timelineFromMessages(nextData.messages)
      });
      setArchives(nextData.archives);
      setGuideStateRecords(nextData.guideStateRecords);
      setWorkflowSnapshots(nextData.workflowSnapshots);
    });
  }

  async function fetchSessionData(sessionId: string) {
    const [messages, archiveRecords, workflowSnapshotRecords, packageStateResults] = await Promise.all([
      listMessages(sessionId),
      listArchives(sessionId),
      listWorkflowSnapshots(sessionId),
      Promise.all(
        WORKBENCH_PACKAGE_STATE_QUERIES.map((query) =>
          listPackageState({
            sessionId,
            packageName: query.packageName,
            collection: query.collection
          })
        )
      )
    ]);

    return {
      messages,
      archives: archiveRecords,
      guideStateRecords: packageStateResults.flat(),
      workflowSnapshots: workflowSnapshotRecords
    };
  }

  async function primeSessionData(sessionId: string) {
    const nextData = await fetchSessionData(sessionId);
    skipNextSessionLoadRef.current = sessionId;
    startTransition(() => {
      setWorkspace({
        ...createInitialWorkspaceState(),
        timeline: timelineFromMessages(nextData.messages)
      });
      setArchives(nextData.archives);
      setGuideStateRecords(nextData.guideStateRecords);
      setTraceEntries([]);
      setWorkflowSnapshots(nextData.workflowSnapshots);
    });
  }

  async function refreshSessionWorkbenchState(sessionId: string) {
    const [workflowSnapshotRecords, packageStateResults] = await Promise.all([
      listWorkflowSnapshots(sessionId),
      Promise.all(
        WORKBENCH_PACKAGE_STATE_QUERIES.map((query) =>
          listPackageState({
            sessionId,
            packageName: query.packageName,
            collection: query.collection
          })
        )
      )
    ]);

    if (selectedSessionIdRef.current !== sessionId) {
      return;
    }

    startTransition(() => {
      setGuideStateRecords(packageStateResults.flat());
      setWorkflowSnapshots(workflowSnapshotRecords);
    });
  }

  async function loadTraceEntries(traceId: string) {
    const entries = await listTraces(traceId);
    startTransition(() => {
      setTraceEntries(entries);
    });
  }

  async function handleCreateWorld(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await createWorldAndSession({
      name: worldName.trim() || starterWorld.name,
      description: worldDescription.trim() || starterWorld.description,
      composerSeed: createOpeningPrompt(worldName.trim() || starterWorld.name, locale)
    });
  }

  async function createWorldAndSession(input: {
    name: string;
    description: string;
    composerSeed: string;
    autoSendPrompt?: string;
    autoGuideTopic?: string;
  }) {
    const world = await createWorld({
      name: input.name,
      description: input.description
    });
    const session = await createSession({
      worldId: world.id,
      taskBindings: {
        [STORY_NARRATION_TASK]: newSessionPresetId || defaultPresetId
      }
    });
    const loadedSessions = await listSessions(world.id);
    selectedSessionIdRef.current = session.id;
    await primeSessionData(session.id);
    startTransition(() => {
      setWorlds((current) => [...current, world]);
      setSelectedWorldId(world.id);
      setSessions(loadedSessions);
      setSelectedSession(session);
      setComposer(input.autoSendPrompt ? "" : input.composerSeed);
      setWorldName("");
      setWorldDescription("");
    });

    if (input.autoSendPrompt) {
      await runSessionAction({
        session,
        content: input.autoSendPrompt,
        optimisticUser: true,
        autoGuideTopic: input.autoGuideTopic
      });
    }
  }

  async function handleCreateStarterWorld() {
    await createWorldAndSession({
      name: starterWorld.name,
      description: starterWorld.description,
      composerSeed: starterWorld.opener,
      autoSendPrompt: starterWorld.opener,
      autoGuideTopic: starterWorld.name
    });
  }

  async function handleCreateSession() {
    if (!selectedWorldId) {
      return;
    }

    const session = await createSession({
      worldId: selectedWorldId,
      taskBindings: {
        [STORY_NARRATION_TASK]: newSessionPresetId || defaultPresetId
      }
    });
    const loadedSessions = await listSessions(selectedWorldId);
    selectedSessionIdRef.current = session.id;
    await primeSessionData(session.id);

    startTransition(() => {
      setSessions(loadedSessions);
      setSelectedSession(session);
      setComposer(createOpeningPrompt(selectedWorld?.name ?? starterWorld.name, locale));
    });
  }

  async function handleSendMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = composer.trim();
    if (!selectedSession || content.length === 0) {
      return;
    }

    await runSessionAction({
      session: selectedSession,
      content,
      optimisticUser: true
    });
  }

  async function runSessionAction(input: {
    session: SessionRecord;
    content: string;
    optimisticUser?: boolean;
    autoGuideTopic?: string;
  }) {
    const content = input.content.trim();
    if (!content) {
      return;
    }

    setStatus("streaming");
    if (input.optimisticUser) {
      startTransition(() => {
        setComposer("");
        setWorkspace((current) => ({
          ...current,
          timeline: [...current.timeline, createOptimisticUserMessage(content)]
        }));
      });
    }

    try {
      const initialEvents = content.startsWith("/")
        ? await executeCommand({
            sessionId: input.session.id,
            command: content
          })
        : await sendMessage({
            sessionId: input.session.id,
            content
          });
      const allEvents = [...initialEvents];

      if (
        input.autoGuideTopic &&
        !content.startsWith("/") &&
        !initialEvents.some((event) => event.type === "block.emitted")
      ) {
        const guideEvents = await executeCommand({
          sessionId: input.session.id,
          command: buildGuideCommand(input.autoGuideTopic)
        });
        allEvents.push(...guideEvents);
      }

      startTransition(() => {
        setWorkspace((current) => {
          let nextState = current;
          for (const nextEvent of allEvents) {
            nextState = applySseEvent(nextState, nextEvent);
          }
          return nextState;
        });
      });

      void refreshSessionWorkbenchState(input.session.id);
    } finally {
      startTransition(() => {
        setStatus("idle");
      });
    }
  }

  function handleComposerChange(nextValue: string) {
    setComposer(nextValue);
  }

  function applySlashCommandSelection(command: CommandSummary) {
    const nextComposer = autocompleteSlashCommand(command);
    setComposer(nextComposer);
    setDismissedSlashQuery(null);
    setSlashSelectedIndex(0);

    queueMicrotask(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(nextComposer.length, nextComposer.length);
    });
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!showSlashMenu || slashSuggestions.length === 0) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSlashSelectedIndex((current) => (current + 1) % slashSuggestions.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSlashSelectedIndex((current) => (current - 1 + slashSuggestions.length) % slashSuggestions.length);
      return;
    }

    if ((event.key === "Enter" || event.key === "Tab") && activeSlashCommand) {
      event.preventDefault();
      applySlashCommandSelection(activeSlashCommand);
      return;
    }

    if (event.key === "Escape" && slashCommandQuery !== null) {
      event.preventDefault();
      setDismissedSlashQuery(slashCommandQuery);
    }
  }

  async function handleSessionPresetChange(presetId: string) {
    if (!selectedSession || presetId.length === 0 || presetId === resolveSessionPresetId(selectedSession, defaultPresetId)) {
      return;
    }

    const updatedSession = await updateSession({
      sessionId: selectedSession.id,
      taskBindings: {
        ...(selectedSession.taskBindings ?? {}),
        [STORY_NARRATION_TASK]: presetId
      },
      presetId
    });

    startTransition(() => {
      setSessions((current) =>
        current.map((session) => (session.id === updatedSession.id ? updatedSession : session))
      );
      setSelectedSession(updatedSession);
    });
  }

  async function handlePresetSave(input: {
    presetId: string;
    model: string;
    enabled: boolean;
    isDefault: boolean;
  }) {
    const updatedPreset = await updatePreset(input);
    const nextPresets = mergePresetSummaries(presets, updatedPreset);

    startTransition(() => {
      setPresets(nextPresets);
      setNewSessionPresetId((current) => resolveSelectablePresetId(nextPresets, current));
    });
  }

  async function handleBlockSelection(optionId: string) {
    if (!selectedSession || !workspace.pendingBlock) {
      return;
    }

    const selectedOptionLabel = ((workspace.pendingBlock.data as {
      options?: Array<{ id: string; label: string }>;
    }).options ?? []).find((option) => option.id === optionId)?.label;
    const nextGuideTopic = selectedOptionLabel
      ?? String((workspace.pendingBlock.data as { title?: string }).title ?? "").trim();

    setStatus("streaming");

    try {
      const resumedEvents = await submitBlockResponse({
        sessionId: selectedSession.id,
        response: {
          blockId: workspace.pendingBlock.id,
          blockType: workspace.pendingBlock.type,
          sessionId: selectedSession.id,
          turnId: workspace.pendingBlock.meta.turnId,
          response: {
            selected: optionId
          }
        }
      });
      const allEvents = [...resumedEvents];

      if (
        nextGuideTopic &&
        !resumedEvents.some((event) => event.type === "block.emitted")
      ) {
        const guideEvents = await executeCommand({
          sessionId: selectedSession.id,
          command: buildGuideCommand(nextGuideTopic)
        });
        allEvents.push(...guideEvents);
      }

      startTransition(() => {
        setWorkspace((current) => {
          let nextState: WorkspaceState = {
            ...current,
            timeline: current.timeline.map((item) => (
              item.kind === "block" && item.id === current.pendingBlock?.id
                ? {
                    ...item,
                    pending: false
                  }
                : item
            )),
            pendingBlock: null
          };
          for (const nextEvent of allEvents) {
            nextState = applySseEvent(nextState, nextEvent);
          }
          return nextState;
        });
      });

      void refreshSessionWorkbenchState(selectedSession.id);
    } finally {
      startTransition(() => {
        setStatus("idle");
      });
    }
  }

  async function handleCreateArchive() {
    if (!selectedSession) {
      return;
    }

    const snapshot = await createArchive({
      sessionId: selectedSession.id,
      turnCutoff: workspace.timeline.length,
      stateSnapshot: {
        timelineCount: workspace.timeline.length
      },
      workingSummary: t("app.archiveWorkingSummary"),
      archiveSummary: t("app.archiveSummary")
    });

    startTransition(() => {
      setArchives((current) => [...current, snapshot.version]);
    });
  }

  async function handleRestoreArchive(archiveVersionId: string) {
    const result = await restoreArchive({
      archiveVersionId,
      mode: "restore-as-fork"
    });
    const loadedSessions = await listSessions(result.session.worldId);

    startTransition(() => {
      setSelectedWorldId(result.session.worldId);
      setSessions(loadedSessions);
      setSelectedSession(result.session);
    });
  }

  function handleSelectSession(sessionId: string) {
    setSelectedSession(sessions.find((session) => session.id === sessionId) ?? null);
  }

  return {
    locale,
    setLocale,
    worlds,
    packages,
    presets,
    sessions,
    archives,
    guideStateRecords,
    traceEntries,
    workflowSnapshots,
    workspace,
    status,
    composer,
    worldName,
    worldDescription,
    selectedWorldId,
    selectedWorld,
    selectedSession,
    starterWorld,
    workbenchTitle,
    workbenchDescription,
    emptyTimelinePrompt,
    activeSessionPresetId,
    activeSessionPresetName,
    enabledPresets,
    sessionPresetOptions,
    newSessionPresetId,
    canSend,
    showSlashMenu,
    slashSuggestions,
    normalizedSlashSelectedIndex,
    composerRef,
    composerFormRef,
    pendingBlockRef,
    setWorldName,
    setWorldDescription,
    setSelectedWorldId,
    setNewSessionPresetId,
    handleCreateWorld,
    handleCreateStarterWorld,
    handleCreateSession,
    handleSendMessage,
    handleComposerChange,
    handleComposerKeyDown,
    applySlashCommandSelection,
    handleSessionPresetChange,
    handlePresetSave,
    handleBlockSelection,
    handleCreateArchive,
    handleRestoreArchive,
    handleSelectSession,
    setSelectedSession
  };
}
