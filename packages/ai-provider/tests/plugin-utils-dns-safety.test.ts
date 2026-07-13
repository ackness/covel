import { lookup } from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPublicIpAddress } from "../src/adapters/http/dns-safety.js";
import { fetchWithRetry } from "../src/plugin-utils.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

const lookupMock = vi.mocked(lookup);

afterEach(() => {
  vi.restoreAllMocks();
  lookupMock.mockReset();
});

describe("DNS SSRF safety", () => {
  it.each([
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:a9fe:a9fe",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"])(
    "accepts public address %s",
    (address) => {
      expect(isPublicIpAddress(address)).toBe(true);
    },
  );

  it("rejects a public hostname whose DNS set contains a private IPv4", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      fetchWithRetry("https://media.example.test/image", { maxRetries: 0 }),
    ).rejects.toThrow(/disallowed address 10\.0\.0\.8/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects private IPv6 and IPv4-mapped IPv6 DNS answers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (const address of ["fd12:3456::1", "::ffff:169.254.169.254"]) {
      lookupMock.mockResolvedValueOnce([{ address, family: 6 }]);
      await expect(
        fetchWithRetry("https://media.example.test/image", { maxRetries: 0 }),
      ).rejects.toThrow(/disallowed address/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-resolves every retry and blocks a rebinding answer", async () => {
    lookupMock
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, {
        status: 503,
        headers: { "retry-after": "0" },
      }),
    );

    await expect(
      fetchWithRetry("https://media.example.test/image", { maxRetries: 1 }),
    ).rejects.toThrow(/disallowed address 127\.0\.0\.1/);
    expect(lookupMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      dispatcher: expect.anything(),
    });
  });

  it("only allows localhost when every DNS answer is loopback", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.8", family: 4 }]);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      fetchWithRetry("http://localhost/image", { maxRetries: 0 }),
    ).rejects.toThrow(/disallowed address 10\.0\.0\.8/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
