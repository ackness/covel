// A record-and-replay proxy in front of an OpenAI-compatible model endpoint,
// built on @copilotkit/aimock. Point a slot's `baseUrl` in llm.toml at it.
//
//   pnpm llm:replay --mode record --fixtures debugs/llm-replay/s1 --upstream https://api.example.com
//   pnpm llm:replay --mode replay --fixtures debugs/llm-replay/s1
//
// record: a request that was recorded before is answered from the fixtures;
//         any other goes to the upstream endpoint and its answer is recorded.
//         `--upstream` is the endpoint's origin, without `/v1`.
// replay: no upstream; a request that was not recorded gets an error.
//
// Other options: `--port <n>` (default 4012) and `--tag <name>` (default: the
// mode), which names the statistics file and the folder of keyed requests
// written next to the fixtures.
//
// A streamed answer is recorded with its timing. `--speed <n>` divides the
// recorded delays on replay (default 1000, as fast as the server reads;
// `--speed 1` keeps the recorded pace).
//
// aimock's own match key is the last user message, the model, the count of
// assistant messages and whether there is a tool result. In Covel the agents
// that run after the narrative end with the same user message, so one would
// get another's answer. The key here is a digest of the whole request.
//
// Docs: docs/guide/e2e-plugin-verify.md
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { LLMock, loadFixturesFromDir } from "@copilotkit/aimock";

const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const MODE = option("mode");
const UPSTREAM = option("upstream");
if (
  (MODE !== "record" && MODE !== "replay") ||
  (MODE === "record" && !UPSTREAM)
) {
  console.error(
    "usage: proxy.mjs --mode record --upstream <origin> --fixtures <dir>\n       proxy.mjs --mode replay --fixtures <dir>",
  );
  process.exit(2);
}
const PORT = Number(option("port", "4012"));
const FIXTURES = option("fixtures", "debugs/llm-replay/default");
const TAG = option("tag", MODE);
const SPEED = Number(option("speed", "1000"));
const STATS = `${FIXTURES}.${TAG}.stats.json`;
// Every request as it is keyed, for `pnpm llm:replay:diff`.
const REQUESTS = `${FIXTURES}.${TAG}.requests`;
mkdirSync(FIXTURES, { recursive: true });
mkdirSync(REQUESTS, { recursive: true });

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

let distinct = 0;
const digest = (request) => {
  const text = normalized(JSON.stringify(keyed(request)));
  const hash = createHash("sha256").update(text).digest("hex");
  // The transform runs more than once for one request; keep one copy.
  const file = `${REQUESTS}/${hash.slice(0, 16)}.json`;
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
  port: PORT,
  logLevel: "warn",
  journalMaxEntries: 0,
  strict: MODE === "replay",
  replaySpeed: SPEED,
  requestTransform: (request) => ({
    ...request,
    messages: [{ role: "user", content: `covel-request:${digest(request)}` }],
  }),
});
const fixtureFiles = () =>
  readdirSync(FIXTURES).filter((name) => name.endsWith(".json"));
// aimock keeps what it records in memory for the life of the process only:
// what an earlier process recorded is loaded here, in record mode too.
mock.addFixtures(loadFixturesFromDir(FIXTURES));
if (MODE === "record")
  mock.enableRecording({
    providers: { openai: UPSTREAM },
    fixturePath: FIXTURES,
    upstreamTimeoutMs: 180_000,
    bodyTimeoutMs: 180_000,
  });
const before = fixtureFiles().length;
await mock.start();
console.log(
  `llm-replay ${MODE} on ${mock.url}, fixtures: ${FIXTURES} (${before} files), upstream: ${MODE === "record" ? UPSTREAM : "none"}`,
);

// On Ctrl-C or SIGTERM: how many requests the fixtures answered.
const finish = async () => {
  const entries = mock
    .getRequests()
    .filter((entry) => entry.path.endsWith("/chat/completions"));
  const served = {};
  for (const entry of entries) {
    const key = `${entry.response.source ?? "none"} ${entry.response.status}`;
    served[key] = (served[key] ?? 0) + 1;
  }
  const stats = {
    mode: MODE,
    tag: TAG,
    chatRequests: entries.length,
    served,
    distinctRequests: distinct,
    fixtureFilesBefore: before,
    fixtureFilesAfter: fixtureFiles().length,
  };
  writeFileSync(STATS, `${JSON.stringify(stats, null, 1)}\n`);
  console.log(JSON.stringify(stats));
  await mock.stop();
  process.exit(0);
};
process.on("SIGTERM", finish);
process.on("SIGINT", finish);
