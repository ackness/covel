/**
 * An OpenAI-compatible chat provider that runs inside the test process.
 *
 * A spec that needs model output without a real provider starts one, points
 * a request at `baseUrl`, and decides each answer with `reply`. The test
 * controls time: an answer can be spread over a duration, stopped after its
 * first piece, or held open until the test lets it end, so a spec can look at
 * the page in the middle of a request without waiting on a clock.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

/** One chat request as the provider received it. */
export interface FakeChatRequest {
  readonly model: string;
  /** The text of each message, in order. */
  readonly messages: readonly string[];
}

/** How the provider answers one request. */
export interface FakeReply {
  readonly text: string;
  /** Spread the answer evenly over this time. Without it the answer is sent at once. */
  readonly streamMs?: number;
  /** Send the first piece and then nothing: the connection stays open. */
  readonly stall?: boolean;
  /** The last piece waits for this, so the request stays in progress until then. */
  readonly hold?: Promise<void>;
}

export interface FakeLlmProvider {
  /** The base URL of the provider: `http://127.0.0.1:<port>/v1`. */
  readonly baseUrl: string;
  /** Every request received, in order. */
  readonly requests: FakeChatRequest[];
  /** Decides the answer to each request. The spec sets it. */
  reply: (request: FakeChatRequest) => FakeReply;
  close(): Promise<void>;
}

/** Time between two pieces of a spread answer. */
const PIECE_INTERVAL_MS = 50;

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function chunk(delta: Record<string, string>, finish: string | null = null) {
  return `data: ${JSON.stringify({
    id: "fake",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { text?: unknown }) =>
      typeof part?.text === "string" ? part.text : "",
    )
    .join("");
}

async function streamReply(res: http.ServerResponse, reply: FakeReply) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const count = reply.stall
    ? 2
    : Math.max(1, Math.round((reply.streamMs ?? 0) / PIECE_INTERVAL_MS));
  const size = Math.max(1, Math.ceil(reply.text.length / count));
  const pieces: string[] = [];
  for (let index = 0; index < reply.text.length; index += size) {
    pieces.push(reply.text.slice(index, index + size));
  }
  const delay = reply.streamMs ? reply.streamMs / pieces.length : 0;

  for (const [index, piece] of pieces.entries()) {
    if (res.destroyed) return;
    const last = index === pieces.length - 1;
    if (last && reply.hold) await reply.hold;
    res.write(chunk({ content: piece }));
    // The caller ends a stalled request; the provider never does.
    if (reply.stall) return;
    if (delay && !last) await pause(delay);
  }
  if (res.destroyed) return;
  res.write(chunk({}, "stop"));
  res.write("data: [DONE]\n\n");
  res.end();
}

export async function startFakeLlmProvider(): Promise<FakeLlmProvider> {
  const requests: FakeChatRequest[] = [];
  const provider = {
    baseUrl: "",
    requests,
    reply: (): FakeReply => ({ text: "" }),
  } as Omit<FakeLlmProvider, "close"> & { baseUrl: string };

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [] }));
      return;
    }
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw || "{}") as {
      model?: string;
      stream?: boolean;
      messages?: { content?: unknown }[];
    };
    const request: FakeChatRequest = {
      model: body.model ?? "",
      messages: (body.messages ?? []).map((message) =>
        messageText(message.content),
      ),
    };
    requests.push(request);
    const reply = provider.reply(request);

    if (body.stream) {
      await streamReply(res, reply);
      return;
    }
    if (reply.hold) await reply.hold;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "fake",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: reply.text },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  provider.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  return Object.assign(provider, {
    close: () =>
      new Promise<void>((resolve) => {
        // A stalled or held answer keeps its connection open.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}
