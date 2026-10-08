// A record-and-replay proxy in front of an OpenAI-compatible model endpoint,
// built on @copilotkit/aimock. `proxy.mjs` runs it from the command line and
// `run.mjs` runs it for the recorded sessions under tests/llm-replay/.
//
// record: a request that was recorded before is answered from the fixtures;
//         any other goes to the upstream endpoint and its answer is recorded.
// replay: no upstream; a request that was not recorded gets an error.
//
// aimock's own match key is the last user message, the model, the count of
// assistant messages and whether there is a tool result. In Covel the agents
// that run after the narrative end with the same user message, so one would
// get another's answer. The key here is a digest of the whole request.
//
// Docs: docs/guide/e2e-plugin-verify.md
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { LLMock, loadFixturesFromDir } from "@copilotkit/aimock";

// What the proxy hands aimock as the only message of a request.
const REQUEST_PREFIX = "covel-request:";

// A replayed tool call may get a new ID, and the ID comes back in the next
// request: it is no part of the key.
const withoutCallIds = (messages) =>
  messages.map((message) => {
    const { tool_call_id: _id, tool_calls: calls, ...rest } = message;
    return calls
      ? { ...rest, tool_calls: calls.map(({ id: _callId, ...call }) => call) }
      : rest;
  });
const keyed = (request) => {
  const {
    messages,
    stream: _stream,
    stream_options: _options,
    ...rest
  } = request;
  return { ...rest, messages: withoutCallIds(messages ?? []) };
};

// What changes from one run of a session to the next and says nothing about
// the request: turn and record IDs (UUIDs), timestamps, and the session ID
// when the test did not fix it. The kernel keeps them out of what it renders;
// this covers text a plugin builds itself. Each is replaced by a placeholder
// that keeps two different values of one request apart.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const SESSION = /\\?"sessionId\\?":\s*\\?"([^"\\]+)\\?"/g;
// A timestamp or a UUID that a length cap cut short, as in
// `"unlockedAt":"2026-10-06T08:51...` and `"token":"a9a3b91b-04...`.
const CUT_TIME = /\d{4}-[\dT:.-]*?(?=\.\.\.)/g;
const CUT_UUID = /[0-9a-f]{8}-[0-9a-f-]*?(?=\.\.\.)/g;
const normalized = (text) => {
  let out = text;
  const sessions = [...new Set([...text.matchAll(SESSION)].map((m) => m[1]))];
  sessions.forEach((id, index) => {
    out = out.split(id).join(`SESSION-${index + 1}`);
  });
  const ids = new Map();
  out = out.replace(UUID, (id) => {
    if (!ids.has(id)) ids.set(id, `UUID-${ids.size + 1}`);
    return ids.get(id);
  });
  return out
    .replace(TIME, "TIME")
    .replace(CUT_UUID, "UUID")
    .replace(CUT_TIME, "TIME");
};

// A stream in which the upstream sent an error is recorded as an answer with
// no content and no usage. Replayed as it is, the server would read an empty
// answer where it had read an error and take another path, so that request is
// answered with an error again, inside a 200 as the upstream sent it.
const failedUpstream = ({ response }) =>
  response?.content === "" &&
  !response.toolCalls &&
  !response.blocks &&
  !response.usage;
const asUpstreamError = (fixture) =>
  failedUpstream(fixture)
    ? {
        ...fixture,
        response: {
          status: 200,
          error: {
            type: "server_error",
            message:
              "The upstream answered with an error when this was recorded.",
          },
        },
      }
    : fixture;

const jsonFiles = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith(".json"))
    : [];

// The request digest a recorded fixture answers, or undefined.
const fixtureHash = (fixture) => {
  const message = fixture?.match?.userMessage;
  return typeof message === "string" && message.startsWith(REQUEST_PREFIX)
    ? message.slice(REQUEST_PREFIX.length)
    : undefined;
};

/** Every request digest the fixture files in `dir` answer. */
export const recordedHashes = (dir) => {
  const hashes = new Set();
  for (const name of jsonFiles(dir)) {
    const file = JSON.parse(readFileSync(join(dir, name), "utf8"));
    for (const fixture of file.fixtures ?? []) {
      const hash = fixtureHash(fixture);
      if (hash) hashes.add(hash);
    }
  }
  return hashes;
};

/**
 * Rewrite the fixture files in `dir` as one file per request, named after the
 * request digest, so that a request that did not change keeps its file and
 * its diff stays empty. The recorded stream timing is left out: a replay that
 * answers as fast as it can does not read it. With `keep`, a fixture whose
 * request is not in it is removed.
 */
export const tidyFixtures = (dir, keep) => {
  const byHash = new Map();
  const names = jsonFiles(dir);
  for (const name of names) {
    const file = JSON.parse(readFileSync(join(dir, name), "utf8"));
    for (const fixture of file.fixtures ?? []) {
      const hash = fixtureHash(fixture);
      if (!hash || byHash.has(hash)) continue;
      const { recordedTimings: _timings, ...rest } = fixture;
      byHash.set(hash, rest);
    }
  }
  const wanted = new Map();
  let removed = 0;
  for (const [hash, fixture] of byHash) {
    if (keep && !keep.has(hash)) {
      removed += 1;
      continue;
    }
    wanted.set(`${hash.slice(0, 16)}.json`, fixture);
  }
  for (const name of names) {
    if (!wanted.has(name)) rmSync(join(dir, name));
  }
  for (const [name, fixture] of wanted) {
    const text = `${JSON.stringify({ fixtures: [fixture] }, null, 2)}\n`;
    const path = join(dir, name);
    if (!existsSync(path) || readFileSync(path, "utf8") !== text)
      writeFileSync(path, text);
  }
  return { kept: wanted.size, removed };
};

/**
 * Start the proxy. `requestsDir` receives every distinct request as it is
 * keyed, for `pnpm llm:replay:diff`. `port: 0` takes a free port. aimock
 * logs each recorded answer at `warn`.
 */
export const startReplayProxy = async ({
  mode,
  fixtures,
  upstream,
  requestsDir,
  port = 4012,
  speed = 1000,
  logLevel = "warn",
}) => {
  mkdirSync(fixtures, { recursive: true });
  mkdirSync(requestsDir, { recursive: true });

  const requested = new Set();
  let distinct = 0;
  const digest = (request) => {
    const text = normalized(JSON.stringify(keyed(request)));
    const hash = createHash("sha256").update(text).digest("hex");
    requested.add(hash);
    // The transform runs more than once for one request; keep one copy.
    const file = `${requestsDir}/${hash.slice(0, 16)}.json`;
    if (!existsSync(file)) {
      distinct += 1;
      writeFileSync(
        file,
        JSON.stringify({ order: distinct, ...JSON.parse(text) }, null, 1),
      );
    }
    return hash;
  };

  const mock = new LLMock({
    port,
    logLevel,
    journalMaxEntries: 0,
    strict: mode === "replay",
    replaySpeed: speed,
    requestTransform: (request) => ({
      ...request,
      messages: [
        { role: "user", content: `${REQUEST_PREFIX}${digest(request)}` },
      ],
    }),
  });
  // aimock keeps what it records in memory for the life of the process only:
  // what an earlier process recorded is loaded here, in record mode too.
  mock.addFixtures(loadFixturesFromDir(fixtures).map(asUpstreamError));
  if (mode === "record")
    mock.enableRecording({
      providers: { openai: upstream },
      fixturePath: fixtures,
      upstreamTimeoutMs: 180_000,
      bodyTimeoutMs: 180_000,
    });
  const fixtureFilesBefore = jsonFiles(fixtures).length;
  await mock.start();

  return {
    url: mock.url,
    fixtureFilesBefore,
    /** The digest of every request the proxy has received. */
    requested: () => new Set(requested),
    /** Stop the proxy; returns how many requests the fixtures answered. */
    stop: async () => {
      const entries = mock
        .getRequests()
        .filter((entry) => entry.path.endsWith("/chat/completions"));
      const served = {};
      for (const entry of entries) {
        const key = `${entry.response.source ?? "none"} ${entry.response.status}`;
        served[key] = (served[key] ?? 0) + 1;
      }
      await mock.stop();
      return {
        mode,
        chatRequests: entries.length,
        served,
        distinctRequests: distinct,
        fixtureFilesBefore,
        fixtureFilesAfter: jsonFiles(fixtures).length,
      };
    },
  };
};
