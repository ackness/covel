import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordedHashes,
  startReplayProxy,
  tidyFixtures,
} from "../llm-replay/replay-proxy.mjs";
import {
  apiKeyName,
  listSessions,
  pointAtProxy,
  readScenario,
} from "../llm-replay/sessions.mjs";

const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-replay-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const fixture = (hash, content) => ({
  match: { userMessage: `covel-request:${hash}`, model: "m", turnIndex: 0 },
  response: { content },
  recordedTimings: { ttftMs: 5, interChunkDelaysMs: [1, 2, 3] },
});
const writeFixtures = (dir, name, fixtures) =>
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ fixtures }, null, 2));

test("every slot of a session's llm.toml goes to the proxy", () => {
  const toml = `# recorded with
[covel.story]
provider = "deepseek"
baseUrl  = "https://api.deepseek.com" # official
model    = "deepseek-flash"

[covel.plugin-heavy]
provider = 'local-gpu'
baseUrl = 'http://127.0.0.1:3425/v1'

[covel.plugin-heavy.providerOptions.local]
baseUrl = "kept"
`;
  const { text, providers } = pointAtProxy(toml, "http://127.0.0.1:4100");
  assert.deepEqual(providers, ["deepseek", "local-gpu"]);
  assert.match(
    text,
    /^baseUrl {2}= "http:\/\/127\.0\.0\.1:4100\/v1" # official$/m,
  );
  assert.match(text, /^baseUrl = "http:\/\/127\.0\.0\.1:4100\/v1"$/m);
  assert.match(text, /^baseUrl = "kept"$/m);
  assert.match(text, /^model {4}= "deepseek-flash"$/m);
});

test("a slot without a baseUrl or a provider is refused", () => {
  assert.throws(
    () =>
      pointAtProxy(
        `[covel.story]\nprovider = "deepseek"\n[covel.plugin]\nprovider = "x"\nbaseUrl = "u"\n`,
        "http://p",
      ),
    /\(story\)/,
  );
  assert.throws(() => pointAtProxy(`[other]\nbaseUrl = "u"\n`, "http://p"));
});

test("provider key names follow the server's convention", () => {
  assert.equal(apiKeyName("deepseek"), "DEEPSEEK_API_KEY");
  assert.equal(apiKeyName("local-gpu"), "LOCAL_GPU_API_KEY");
});

test("a scenario names its world, session ID, seed and turns", (t) => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, "ok"));
  fs.writeFileSync(
    path.join(root, "ok", "scenario.json"),
    JSON.stringify({ world: "w", sessionId: "s", seed: "1", turns: 2 }),
  );
  fs.mkdirSync(path.join(root, "bad"));
  fs.writeFileSync(
    path.join(root, "bad", "scenario.json"),
    JSON.stringify({ world: "w", sessionId: "s", seed: "1", turns: 0 }),
  );
  fs.mkdirSync(path.join(root, "notes"));
  assert.deepEqual(listSessions(root), ["bad", "ok"]);
  assert.deepEqual(readScenario(root, "ok"), {
    locale: "zh-CN",
    world: "w",
    sessionId: "s",
    seed: "1",
    turns: 2,
    args: [],
  });
  assert.throws(() => readScenario(root, "bad"), /turns/);
  assert.throws(() => readScenario(root, "missing"), /no session/);
});

test("tidying names each answer after its request and drops the timing", (t) => {
  const dir = tempDir(t);
  writeFixtures(dir, "openai-2026-10-08T08-00-00-000Z-1.json", [
    fixture(HASH_A, "first"),
  ]);
  writeFixtures(dir, "openai-2026-10-08T08-00-01-000Z-2.json", [
    fixture(HASH_B, "second"),
    fixture(HASH_A, "duplicate"),
  ]);

  assert.deepEqual(tidyFixtures(dir), { kept: 2, removed: 0 });
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    `${HASH_A.slice(0, 16)}.json`,
    `${HASH_B.slice(0, 16)}.json`,
  ]);
  const a = JSON.parse(
    fs.readFileSync(path.join(dir, `${HASH_A.slice(0, 16)}.json`), "utf8"),
  );
  assert.equal(a.fixtures.length, 1);
  assert.equal(a.fixtures[0].response.content, "first");
  assert.equal(a.fixtures[0].recordedTimings, undefined);
  assert.deepEqual(recordedHashes(dir), new Set([HASH_A, HASH_B]));
});

test("tidying with the requests of a run removes the answers it did not use", (t) => {
  const dir = tempDir(t);
  writeFixtures(dir, "one.json", [fixture(HASH_A, "a")]);
  writeFixtures(dir, "two.json", [fixture(HASH_B, "b")]);
  tidyFixtures(dir);
  const kept = path.join(dir, `${HASH_A.slice(0, 16)}.json`);
  const before = fs.statSync(kept).mtimeMs;

  assert.deepEqual(tidyFixtures(dir, new Set([HASH_A])), {
    kept: 1,
    removed: 1,
  });
  assert.deepEqual(fs.readdirSync(dir), [`${HASH_A.slice(0, 16)}.json`]);
  assert.equal(fs.statSync(kept).mtimeMs, before);
});

test("a replayed request is answered from the recording and others are refused", async (t) => {
  const dir = tempDir(t);
  const requestsDir = path.join(dir, "requests");
  const recording = path.join(dir, "recording");
  const ask = (url, content) =>
    fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [
          {
            role: "system",
            content: `turn 2026-10-08T08:00:00.000Z, row 1b4e28ba-2fa1-11d2-883f-0016d3cca427`,
          },
          { role: "user", content },
        ],
      }),
    });

  // Learn the digest of one request, then record an answer for it.
  const probe = await startReplayProxy({
    mode: "replay",
    fixtures: recording,
    requestsDir,
    port: 0,
    logLevel: "silent",
  });
  await ask(probe.url, "hello");
  const [hash] = probe.requested();
  await probe.stop();
  writeFixtures(recording, "answer.json", [fixture(hash, "recorded answer")]);

  const proxy = await startReplayProxy({
    mode: "replay",
    fixtures: recording,
    requestsDir,
    port: 0,
    logLevel: "silent",
  });
  t.after(() => proxy.stop().catch(() => {}));
  // Timestamps and UUIDs are no part of the key.
  const hit = await fetch(`${proxy.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "m",
      messages: [
        {
          role: "system",
          content: `turn 2027-01-01T00:00:00Z, row 9e107d9d-372b-4c63-8e7a-2a1c3d0b5e6f`,
        },
        { role: "user", content: "hello" },
      ],
    }),
  });
  assert.equal(hit.status, 200);
  assert.equal(
    (await hit.json()).choices[0].message.content,
    "recorded answer",
  );
  const miss = await ask(proxy.url, "something else");
  assert.equal(miss.status, 503);
  assert.equal(proxy.requested().size, 2);
});
