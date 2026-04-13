/**
 * Replay cache: hash stability, record/replay/auto modes, streaming tee,
 * size cap, and sensitive-field redaction.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { postJson } from "../src/adapters/http.js";
import {
  hashRequest,
  loadCached,
  saveCached,
  responseFromCache,
  buildStreamEntry,
  getReplayMode,
  getCacheDir,
} from "../src/adapters/replay-cache.js";
import type { ProviderConfig } from "../src/types.js";

const CONFIG: ProviderConfig = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "test-key",
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "covel-replay-"));
  process.env.COVEL_LLM_REPLAY_DIR = tmpDir;
  process.env.COVEL_LLM_RETRY_DISABLED = "1"; // skip retry loop noise
});

afterEach(() => {
  delete process.env.COVEL_LLM_REPLAY;
  delete process.env.COVEL_LLM_REPLAY_DIR;
  delete process.env.COVEL_LLM_RETRY_DISABLED;
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("hashRequest", () => {
  it("is stable across object key reordering", () => {
    const a = hashRequest("POST", "https://x/y", { model: "m", messages: [{ role: "user", content: "hi" }] });
    const b = hashRequest("POST", "https://x/y", { messages: [{ role: "user", content: "hi" }], model: "m" });
    expect(a).toBe(b);
  });

  it("differs when body changes", () => {
    const a = hashRequest("POST", "https://x/y", { model: "m1" });
    const b = hashRequest("POST", "https://x/y", { model: "m2" });
    expect(a).not.toBe(b);
  });

  it("differs when url changes", () => {
    const a = hashRequest("POST", "https://x/a", { v: 1 });
    const b = hashRequest("POST", "https://x/b", { v: 1 });
    expect(a).not.toBe(b);
  });

  it("redacts sensitive keys before hashing", () => {
    const a = hashRequest("POST", "https://x/y", { model: "m", api_key: "secret-1" });
    const b = hashRequest("POST", "https://x/y", { model: "m", api_key: "secret-2" });
    expect(a).toBe(b);
  });
});

describe("getReplayMode", () => {
  it("defaults to off", () => {
    delete process.env.COVEL_LLM_REPLAY;
    expect(getReplayMode()).toBe("off");
  });

  it("parses record/replay/auto", () => {
    process.env.COVEL_LLM_REPLAY = "record";
    expect(getReplayMode()).toBe("record");
    process.env.COVEL_LLM_REPLAY = "REPLAY";
    expect(getReplayMode()).toBe("replay");
    process.env.COVEL_LLM_REPLAY = "auto";
    expect(getReplayMode()).toBe("auto");
  });

  it("treats unknown values as off", () => {
    process.env.COVEL_LLM_REPLAY = "garbage";
    expect(getReplayMode()).toBe("off");
  });
});

describe("getCacheDir", () => {
  it("uses env override", () => {
    expect(getCacheDir()).toBe(tmpDir);
  });
});

describe("saveCached / loadCached round-trip", () => {
  it("persists and reloads a JSON entry", () => {
    const hash = "abc123";
    saveCached(hash, {
      request: {
        method: "POST",
        url: "https://x/y",
        body: { model: "m" },
        bodyHash: hash,
        recordedAt: new Date().toISOString(),
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        bodyText: '{"ok":true}',
      },
    });
    const loaded = loadCached(hash);
    expect(loaded?.response.bodyText).toBe('{"ok":true}');
    expect(existsSync(join(tmpDir, "index.jsonl"))).toBe(true);
  });

  it("returns null on miss", () => {
    expect(loadCached("nonexistent")).toBeNull();
  });
});

describe("responseFromCache", () => {
  it("rebuilds a usable Response for JSON", async () => {
    const entry = {
      request: { method: "POST", url: "https://x/y", body: {}, bodyHash: "h", recordedAt: "" },
      response: { status: 200, statusText: "OK", headers: {}, bodyText: '{"hello":"world"}' },
    };
    const res = responseFromCache(entry);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: "world" });
  });

  it("rebuilds an SSE Response", async () => {
    const sse = 'data: {"a":1}\n\ndata: [DONE]\n\n';
    const res = responseFromCache({
      request: { method: "POST", url: "https://x/y", body: {}, bodyHash: "h", recordedAt: "" },
      response: { status: 200, statusText: "OK", headers: {}, sseText: sse },
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(sse);
  });
});

describe("postJson integration — auto mode", () => {
  it("records a JSON response on first call, replays on second", async () => {
    process.env.COVEL_LLM_REPLAY = "auto";

    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response('{"id":"resp-1"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const r1 = await postJson(CONFIG, "/chat/completions", { model: "m", input: "hi" });
    expect(await r1.json()).toEqual({ id: "resp-1" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Cache file should now exist.
    const files = readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);

    // Second call: should NOT hit fetch.
    const r2 = await postJson(CONFIG, "/chat/completions", { model: "m", input: "hi" });
    expect(await r2.json()).toEqual({ id: "resp-1" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("ignores non-2xx responses", async () => {
    process.env.COVEL_LLM_REPLAY = "auto";
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response('{"error":"nope"}', {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    );
    await postJson(CONFIG, "/chat/completions", { model: "m" });
    const files = readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(0);
  });
});

describe("postJson integration — replay mode", () => {
  it("throws when no cache present", async () => {
    process.env.COVEL_LLM_REPLAY = "replay";
    const fetchSpy = vi.spyOn(global, "fetch");
    await expect(
      postJson(CONFIG, "/chat/completions", { model: "m" })
    ).rejects.toThrow(/No cached entry/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns cached without hitting network", async () => {
    process.env.COVEL_LLM_REPLAY = "replay";
    const url = "https://api.openai.com/v1/chat/completions";
    const body = { model: "m" };
    const hash = hashRequest("POST", url, body);
    saveCached(hash, {
      request: { method: "POST", url, body, bodyHash: hash, recordedAt: "" },
      response: { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, bodyText: '{"cached":true}' },
    });
    const fetchSpy = vi.spyOn(global, "fetch");
    const res = await postJson(CONFIG, "/chat/completions", body);
    expect(await res.json()).toEqual({ cached: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("postJson integration — record mode", () => {
  it("always overwrites cache, never replays", async () => {
    process.env.COVEL_LLM_REPLAY = "record";
    const url = "https://api.openai.com/v1/chat/completions";
    const body = { model: "m" };
    const hash = hashRequest("POST", url, body);

    // Pre-populate with stale value.
    saveCached(hash, {
      request: { method: "POST", url, body, bodyHash: hash, recordedAt: "" },
      response: { status: 200, statusText: "OK", headers: {}, bodyText: '{"old":true}' },
    });

    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response('{"fresh":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const res = await postJson(CONFIG, "/chat/completions", body);
    expect(await res.json()).toEqual({ fresh: true });

    const reloaded = loadCached(hash);
    expect(reloaded?.response.bodyText).toBe('{"fresh":true}');
  });
});

describe("postJson integration — streaming tee", () => {
  it("forwards stream live AND records SSE body", async () => {
    process.env.COVEL_LLM_REPLAY = "auto";
    const sseBody = 'data: {"chunk":1}\n\ndata: {"chunk":2}\n\ndata: [DONE]\n\n';

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseBody));
        controller.close();
      },
    });

    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    );

    const res = await postJson(CONFIG, "/chat/completions", { model: "m", stream: true });
    const text = await res.text();
    expect(text).toBe(sseBody);

    // Wait a tick for the flush callback to write the cache.
    await new Promise((r) => setTimeout(r, 10));

    const files = readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    const entry = JSON.parse(readFileSync(join(tmpDir, files[0]), "utf8"));
    expect(entry.response.sseText).toBe(sseBody);
  });

  it("replays a recorded stream byte-for-byte", async () => {
    process.env.COVEL_LLM_REPLAY = "auto";
    const sseBody = 'data: {"v":1}\n\ndata: [DONE]\n\n';
    const url = "https://api.openai.com/v1/chat/completions";
    const body = { model: "m", stream: true };
    const hash = hashRequest("POST", url, body);
    saveCached(hash, buildStreamEntry(hash, "POST", url, body, sseBody, { "content-type": "text/event-stream" }, 200, "OK"));

    const fetchSpy = vi.spyOn(global, "fetch");
    const res = await postJson(CONFIG, "/chat/completions", body);
    expect(await res.text()).toBe(sseBody);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("off mode is a true no-op", () => {
  it("does not touch the cache dir when env unset", async () => {
    delete process.env.COVEL_LLM_REPLAY;
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } })
    );
    await postJson(CONFIG, "/chat/completions", { model: "m" });
    expect(existsSync(join(tmpDir, "index.jsonl"))).toBe(false);
  });
});

describe("redaction in saved entries", () => {
  it("removes sensitive body keys from disk", async () => {
    process.env.COVEL_LLM_REPLAY = "record";
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } })
    );
    await postJson(CONFIG, "/chat/completions", {
      model: "m",
      api_key: "should-not-leak",
      nested: { token: "also-secret" },
    });
    const files = readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    const content = readFileSync(join(tmpDir, files[0]), "utf8");
    expect(content).not.toContain("should-not-leak");
    expect(content).not.toContain("also-secret");
    expect(content).toContain("<REDACTED>");
  });
});
