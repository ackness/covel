// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import { fetchUiSpecs } from "../api/plugin-data.js";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  i18n: { language: "en-US" },
}));
vi.mock("../api/request.js", () => ({ request: mocks.request }));
vi.mock("@/i18n/index.js", () => ({ default: mocks.i18n }));
beforeEach(() => {
  mocks.request.mockReset();
  mocks.i18n.language = "en-US";
});

it("shares only in-flight reads for the same session, plugin set and language", async () => {
  let resolve!: (value: unknown) => void;
  mocks.request.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const first = fetchUiSpecs("s", "a");
  expect(fetchUiSpecs("s", "a")).toBe(first);
  resolve({ right: [] });
  await first;
  mocks.request.mockResolvedValue({ right: [] });
  const next = fetchUiSpecs("s", "a");
  expect(next).not.toBe(first);
  const otherSession = fetchUiSpecs("other", "a");
  const otherPlugins = fetchUiSpecs("s", "b");
  mocks.i18n.language = "zh-CN";
  const otherLanguage = fetchUiSpecs("s", "a");
  expect(new Set([next, otherSession, otherPlugins, otherLanguage]).size).toBe(
    4,
  );
  await Promise.all([next, otherSession, otherPlugins, otherLanguage]);
  expect(mocks.request).toHaveBeenCalledTimes(5);
});

it("allows a failed read to be retried", async () => {
  mocks.request.mockRejectedValueOnce(new Error("offline"));
  const failed = fetchUiSpecs("s", "a");
  expect(fetchUiSpecs("s", "a")).toBe(failed);
  await expect(failed).rejects.toThrow("offline");
  mocks.request.mockResolvedValue({ right: [] });
  await expect(fetchUiSpecs("s", "a")).resolves.toEqual({ right: [] });
  expect(mocks.request).toHaveBeenCalledTimes(2);
});

it("preserves view entries in the client response", async () => {
  const response: import("../api/plugin-data.js").UISpecsResponse = {
    right: [],
    message: [],
    view: [
      {
        pluginId: "p",
        specs: [
          {
            id: "reader",
            label: "Reader",
            bridge: "session",
            webview: { html: "<p>Reader</p>" },
          },
        ],
      },
    ],
  };
  mocks.request.mockResolvedValue(response);
  await expect(fetchUiSpecs("s", "p")).resolves.toEqual(response);
});
