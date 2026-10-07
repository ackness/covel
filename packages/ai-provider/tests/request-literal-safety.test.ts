import { afterEach, expect, it, vi } from "vitest";
import { getJson, postJson } from "../src/adapters/http.js";

afterEach(() => vi.unstubAllGlobals());

it.each([
  "198.18.1.1",
  "100.64.0.1",
  "127.0.0.2",
  "224.0.0.1",
  "[::]",
  "[ff02::1]",
  "[::ffff:198.18.1.1]",
  "[2001:2::1]",
  "[2001:100::1]",
  "[2002:a00:1::1]",
  "[3fff::1]",
  "[2001::1]",
])(
  "rejects nonpublic literal %s before any core provider network request",
  async (host) => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    const config = { baseUrl: `https://${host}` };
    await expect(postJson(config, "/chat/completions", {})).rejects.toThrow(
      "not allowed",
    );
    await expect(getJson(config, "/models")).rejects.toThrow("not allowed");
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each([
  "[2001:4860:4860::8888]",
  "[2606:4700:4700::1111]",
  "[2001:3::1]",
  "[2001:4:112::1]",
])("retains public IPv6 provider %s", async (host) => {
  const fetch = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  expect(
    (await getJson({ baseUrl: `https://${host}` }, "/models")).status,
  ).toBe(200);
  expect(fetch).toHaveBeenCalledTimes(1);
});
