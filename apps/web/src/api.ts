import type {
  ArchiveRecord,
  BlockResponse,
  MessageRecord,
  PackageSummary,
  TraceRecord,
  SessionRecord,
  SseEnvelope,
  WorldRecord
} from "./types.js";

const API_BASE_URL = "";

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(String((payload as { error?: unknown }).error ?? `HTTP ${response.status}`));
  }

  return response.json() as Promise<T>;
}

export async function listWorlds(): Promise<WorldRecord[]> {
  return readJson(await fetch(`${API_BASE_URL}/worlds`));
}

export async function createWorld(input: {
  name: string;
  description: string;
}): Promise<WorldRecord> {
  return readJson(await fetch(`${API_BASE_URL}/worlds`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(input)
  }));
}

export async function listPackages(): Promise<PackageSummary[]> {
  return readJson(await fetch(`${API_BASE_URL}/packages`));
}

export async function listSessions(worldId: string): Promise<SessionRecord[]> {
  return readJson(await fetch(`${API_BASE_URL}/sessions?worldId=${encodeURIComponent(worldId)}`));
}

export async function listMessages(sessionId: string): Promise<MessageRecord[]> {
  return readJson(await fetch(`${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/messages`));
}

export async function listArchives(sessionId: string): Promise<ArchiveRecord[]> {
  return readJson(await fetch(`${API_BASE_URL}/archives?sessionId=${encodeURIComponent(sessionId)}`));
}

export async function listTraces(traceId: string): Promise<TraceRecord[]> {
  return readJson(await fetch(`${API_BASE_URL}/traces?traceId=${encodeURIComponent(traceId)}`));
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
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(input)
  }));
}

export async function restoreArchive(input: {
  archiveVersionId: string;
  mode: "restore-in-place" | "restore-as-fork";
}): Promise<{ session: SessionRecord }> {
  return readJson(await fetch(`${API_BASE_URL}/archives/${encodeURIComponent(input.archiveVersionId)}/restore`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
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
    payload: {
      content: input.content
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
    payload: input.response
  });
}

async function postAction(body: Record<string, unknown>): Promise<SseEnvelope[]> {
  const response = await fetch(`${API_BASE_URL}/actions`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
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
