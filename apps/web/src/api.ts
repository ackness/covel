import type {
  ArchiveRecord,
  BlockResponse,
  CommandSummary,
  MessageRecord,
  PackageStateRecord,
  PackageSummary,
  PresetSummary,
  TraceRecord,
  SessionRecord,
  SseEnvelope,
  WorkflowSnapshotRecord,
  WorldRecord
} from "./types.js";
import { getStoredLocale } from "./i18n.js";

const API_BASE_URL = "";

function createJsonHeaders(): HeadersInit {
  return {
    "accept-language": getStoredLocale(),
    "content-type": "application/json"
  };
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const errorPayload = (payload as {
      error?: string | {
        code?: string;
        message?: string;
      };
    }).error;
    throw new Error(String(
      typeof errorPayload === "string"
        ? errorPayload
        : errorPayload?.message ?? errorPayload?.code ?? `HTTP ${response.status}`
    ));
  }

  return response.json() as Promise<T>;
}

export async function listWorlds(): Promise<WorldRecord[]> {
  return readJson(await fetch(`${API_BASE_URL}/worlds`, {
    headers: {
      "accept-language": getStoredLocale()
    }
  }));
}

export async function createWorld(input: {
  name: string;
  description: string;
}): Promise<WorldRecord> {
  return readJson(await fetch(`${API_BASE_URL}/worlds`, {
    method: "POST",
    headers: createJsonHeaders(),
    body: JSON.stringify(input)
  }));
}

export async function listPackages(): Promise<PackageSummary[]> {
  return readJson(await fetch(`${API_BASE_URL}/packages`, {
    headers: {
      "accept-language": getStoredLocale()
    }
  }));
}

export async function listCommands(): Promise<CommandSummary[]> {
  return readJson(await fetch(`${API_BASE_URL}/commands`, {
    headers: {
      "accept-language": getStoredLocale()
    }
  }));
}

export async function listPresets(): Promise<PresetSummary[]> {
  return readJson(await fetch(`${API_BASE_URL}/presets`, {
    headers: {
      "accept-language": getStoredLocale()
    }
  }));
}

export async function updatePreset(input: {
  presetId: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
}): Promise<PresetSummary> {
  return readJson(await fetch(`${API_BASE_URL}/presets/${encodeURIComponent(input.presetId)}`, {
    method: "PATCH",
    headers: createJsonHeaders(),
    body: JSON.stringify({
      model: input.model,
      enabled: input.enabled,
      isDefault: input.isDefault
    })
  }));
}

export async function listSessions(worldId: string): Promise<SessionRecord[]> {
  return readJson(await fetch(`${API_BASE_URL}/sessions?worldId=${encodeURIComponent(worldId)}`, {
    headers: {
      "accept-language": getStoredLocale()
    }
  }));
}

export async function createSession(input: {
  worldId: string;
  taskBindings?: Record<string, string>;
  presetId?: string;
}): Promise<SessionRecord> {
  return readJson(await fetch(`${API_BASE_URL}/sessions`, {
    method: "POST",
    headers: createJsonHeaders(),
    body: JSON.stringify(input)
  }));
}

export async function updateSession(input: {
  sessionId: string;
  taskBindings?: Record<string, string>;
  presetId: string;
}): Promise<SessionRecord> {
  return readJson(await fetch(`${API_BASE_URL}/sessions/${encodeURIComponent(input.sessionId)}`, {
    method: "PATCH",
    headers: createJsonHeaders(),
    body: JSON.stringify({
      ...(input.taskBindings ? { taskBindings: input.taskBindings } : {}),
      presetId: input.presetId
    })
  }));
}

export async function listMessages(sessionId: string): Promise<MessageRecord[]> {
  return readJson(await fetch(`${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/messages`, {
    headers: {
      "accept-language": getStoredLocale()
    }
  }));
}

export async function listWorkflowSnapshots(sessionId: string): Promise<WorkflowSnapshotRecord[]> {
  return readJson(await fetch(`${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/workflow-snapshots`, {
    headers: {
      "accept-language": getStoredLocale()
    }
  }));
}

export async function listPackageState(input: {
  sessionId: string;
  packageName: string;
  collection: string;
}): Promise<PackageStateRecord[]> {
  const search = new URLSearchParams({
    packageName: input.packageName,
    collection: input.collection
  });

  return readJson(await fetch(
    `${API_BASE_URL}/sessions/${encodeURIComponent(input.sessionId)}/package-state?${search.toString()}`,
    {
      headers: {
        "accept-language": getStoredLocale()
      }
    }
  ));
}

export async function listArchives(sessionId: string): Promise<ArchiveRecord[]> {
  return readJson(await fetch(`${API_BASE_URL}/archives?sessionId=${encodeURIComponent(sessionId)}`, {
    headers: {
      "accept-language": getStoredLocale()
    }
  }));
}

export async function listTraces(traceId: string): Promise<TraceRecord[]> {
  return readJson(await fetch(`${API_BASE_URL}/traces?traceId=${encodeURIComponent(traceId)}`, {
    headers: {
      "accept-language": getStoredLocale()
    }
  }));
}

export async function createArchive(input: {
  sessionId: string;
  turnCutoff: number;
  stateSnapshot: Record<string, unknown>;
  workingSummary: string;
  archiveSummary: string;
}): Promise<{ version: ArchiveRecord }> {
  return readJson(await fetch(`${API_BASE_URL}/archives`, {
    method: "POST",
    headers: createJsonHeaders(),
    body: JSON.stringify(input)
  }));
}

export async function restoreArchive(input: {
  archiveVersionId: string;
  mode: "restore-in-place" | "restore-as-fork";
}): Promise<{ session: SessionRecord }> {
  return readJson(await fetch(`${API_BASE_URL}/archives/${encodeURIComponent(input.archiveVersionId)}/restore`, {
    method: "POST",
    headers: createJsonHeaders(),
    body: JSON.stringify({
      mode: input.mode
    })
  }));
}

export async function sendMessage(input: {
  sessionId: string;
  content: string;
}): Promise<SseEnvelope[]> {
  return postAction({
    requestId: `req_${Date.now()}`,
    type: "send_message",
    sessionId: input.sessionId,
    locale: getStoredLocale(),
    payload: {
      content: input.content
    }
  });
}

export async function executeCommand(input: {
  sessionId: string;
  command: string;
}): Promise<SseEnvelope[]> {
  return postAction({
    requestId: `req_${Date.now()}`,
    type: "execute_command",
    sessionId: input.sessionId,
    locale: getStoredLocale(),
    payload: {
      command: input.command
    }
  });
}

export async function submitBlockResponse(input: {
  sessionId: string;
  response: BlockResponse;
}): Promise<SseEnvelope[]> {
  return postAction({
    requestId: `req_${Date.now()}`,
    type: "submit_block_response",
    sessionId: input.sessionId,
    locale: getStoredLocale(),
    payload: input.response
  });
}

async function postAction(body: Record<string, unknown>): Promise<SseEnvelope[]> {
  const response = await fetch(`${API_BASE_URL}/actions`, {
    method: "POST",
    headers: createJsonHeaders(),
    body: JSON.stringify(body)
  });

  if (!response.ok || !response.body) {
    return readJson<SseEnvelope[]>(response);
  }

  return readSseEvents(response);
}

async function readSseEvents(response: Response): Promise<SseEnvelope[]> {
  const reader = response.body?.getReader();
  if (!reader) {
    return [];
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const events: SseEnvelope[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (buffer.includes("\n\n")) {
      const boundary = buffer.indexOf("\n\n");
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const lines = frame.split("\n");
      const dataLine = lines.find((line) => line.startsWith("data: "));
      if (!dataLine) {
        continue;
      }

      events.push(JSON.parse(dataLine.slice(6)) as SseEnvelope);
    }
  }

  return events;
}
