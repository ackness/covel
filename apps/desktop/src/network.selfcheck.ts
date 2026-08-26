import assert from "node:assert/strict";
import { fetchWithTimeout } from "./network.js";

const neverResponds = ((_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("aborted", "AbortError"));
    });
  })) as typeof fetch;

const started = Date.now();
await assert.rejects(
  fetchWithTimeout("http://127.0.0.1/hung", 20, neverResponds),
  (error: unknown) =>
    error instanceof DOMException && error.name === "AbortError",
);
assert.ok(Date.now() - started < 1_000);

console.log("network selfcheck: OK");
