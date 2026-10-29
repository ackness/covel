import { describe, expect, it } from "vitest";
import {
  capabilitiesWithin,
  normalizeTrustedSources,
  pluginCapabilitiesSchema,
  trustedSourceEntrySchema,
  trustedSourceMatches,
  describeServerSetting,
  TRUSTED_SOURCES_SERVER_SETTING,
  githubPluginPreviewSchema,
  pluginInstallationSchema,
} from "../src/index.js";
const empty = () =>
  pluginCapabilitiesSchema.parse({
    serverCode: false,
    http: [],
    hooks: [],
    tools: [],
    actions: [],
    services: [],
    wires: [],
    extensions: [],
    forms: [],
    datasets: [],
  });
describe("trusted sources", () => {
  it("normalizes, sorts and deduplicates without discarding invalid input", () => {
    expect(normalizeTrustedSources([" B/repo ", "a", "b/REPO"])).toEqual([
      "a",
      "b/repo",
    ]);
    expect(() => normalizeTrustedSources(["a", "bad/"])).toThrow();
    expect(trustedSourceEntrySchema.parse(" COVEL-AI/Repo.name_1 ")).toBe(
      "covel-ai/repo.name_1",
    );
  });
  it.each([
    "owner/",
    "/repo",
    "a/b/c",
    "https://github.com/a/b",
    "",
    "a".repeat(40),
    "中文",
    "-owner",
    "a/" + "b".repeat(99),
  ])("rejects %s", (entry) => {
    expect(trustedSourceEntrySchema.safeParse(entry).success).toBe(false);
  });
  it.each([
    [["covel-ai"], "https://github.com/covel-ai/x", true],
    [["covel-ai"], "https://github.com/covel-ai-evil/x", false],
    [["owner/repo"], "https://github.com/owner/repo", true],
    [["owner/repo"], "https://github.com/owner/repo-evil", false],
    [["owner/repo"], "https://github.com/owner/repo2", false],
    [["OWNER/REPO"], "https://GITHUB.COM/Owner/Repo", true],
    [["owner"], "https://elsewhere.com/owner/repo", false],
    [["owner"], "http://github.com/owner/repo", false],
    [["owner"], "https://github.com/owner/repo.git", false],
    [["owner"], "https://github.com/owner/repo/", false],
    [["owner"], "https://github.com/owner/repo?x", false],
    [["owner"], "https://github.com/owner/repo#x", false],
    [["owner"], "https://github.com/owner/repo/extra", false],
    [[], "https://github.com/owner/repo", false],
    [["owner"], "not a URL", false],
  ] as const)("matches %j against %s: %s", (entries, url, matches) =>
    expect(trustedSourceMatches(entries, url)).toBe(matches),
  );
});
describe("capability subsets", () => {
  const snapshot = pluginCapabilitiesSchema.parse({
    ...empty(),
    serverCode: true,
    http: [{ origin: "https://a.test", methods: ["POST", "GET"] }],
    hooks: [{ event: "PreToolUse", enforce: "normal" }],
    tools: ["a"],
    actions: ["a"],
    services: ["a@1"],
    wires: ["a"],
    forms: ["a"],
    extensions: ["a@1/b"],
    datasets: [{ namespace: "notes", ops: ["set"] }],
  });
  it("accepts equal and smaller sets", () => {
    expect(capabilitiesWithin(snapshot, snapshot)).toBe(true);
    expect(capabilitiesWithin(empty(), snapshot)).toBe(true);
    expect(
      capabilitiesWithin(
        { ...snapshot, http: [{ origin: "https://a.test", methods: ["GET"] }] },
        snapshot,
      ),
    ).toBe(true);
  });
  it.each([
    "tools",
    "actions",
    "services",
    "wires",
    "forms",
    "extensions",
  ] as const)("rejects added %s", (key) =>
    expect(
      capabilitiesWithin(
        { ...snapshot, [key]: [...snapshot[key], "new"] },
        snapshot,
      ),
    ).toBe(false),
  );
  it.each([
    { http: [{ origin: "https://b.test", methods: ["GET"] }] },
    { http: [{ origin: "https://a.test", methods: ["DELETE"] }] },
    { hooks: [{ event: "PostToolUse", enforce: "normal" as const }] },
    { hooks: [{ event: "PreToolUse", enforce: "pre" as const }] },
    { datasets: [{ namespace: "new", ops: ["set"] }] },
    { datasets: [{ namespace: "notes", ops: ["delete"] }] },
  ])("rejects growth in %j", (growth) =>
    expect(capabilitiesWithin({ ...snapshot, ...growth }, snapshot)).toBe(
      false,
    ),
  );
  it("requires server code in the snapshot", () =>
    expect(capabilitiesWithin({ ...empty(), serverCode: true }, empty())).toBe(
      false,
    ));
  it("canonicalizes nested lists, hooks and duplicate origins/datasets", () => {
    const result = pluginCapabilitiesSchema.parse({
      ...empty(),
      tools: ["b", "a", "b"],
      http: [
        { origin: "https://a.test", methods: ["POST"] },
        { origin: "https://a.test", methods: ["GET"] },
      ],
      hooks: [
        { event: "PreToolUse" },
        { event: "PreToolUse", enforce: "normal" },
      ],
    });
    expect(result.tools).toEqual(["a", "b"]);
    expect(result.http).toEqual([
      { origin: "https://a.test", methods: ["GET", "POST"] },
    ]);
    expect(result.hooks).toEqual([{ event: "PreToolUse", enforce: "normal" }]);
    expect(
      pluginCapabilitiesSchema.safeParse({ ...empty(), extra: true }).success,
    ).toBe(false);
  });
});
describe("trusted-source server setting", () => {
  it("uses env over stored, stored only on writable hosts, and ignores invalid values", () => {
    const describe = (stored: unknown, writable: boolean, raw?: string) =>
      describeServerSetting(TRUSTED_SOURCES_SERVER_SETTING, stored, writable, {
        COVEL_TRUSTED_SOURCES: raw,
      });
    expect(describe(["a"], true, " B/repo,a ")).toEqual({
      value: ["a", "b/repo"],
      source: "env",
      settable: false,
    });
    expect(describe(["A"], true)).toEqual({
      value: ["a"],
      source: "setting",
      settable: true,
    });
    expect(describe(["a"], false)).toEqual({
      value: [],
      source: "default",
      settable: false,
    });
    expect(describe(["a/"], true)).toMatchObject({
      value: [],
      source: "default",
    });
    expect(describe(["a"], true, "b,invalid/")).toMatchObject({
      value: ["a"],
      source: "setting",
    });
  });
});
it("requires capabilities and source trust in previews, integrity in installation lists", () => {
  const source = {
    repository: "https://github.com/a/b",
    commit: "a".repeat(40),
    digest: "b".repeat(64),
    path: "",
    tracking: { kind: "default-branch" },
  };
  const preview = {
    id: "a",
    version: null,
    description: "",
    author: null,
    hasServerCode: false,
    source,
    token: "token",
    expiresAt: 1,
    capabilities: empty(),
    trustedSource: false,
  };
  expect(githubPluginPreviewSchema.safeParse(preview).success).toBe(true);
  expect(
    githubPluginPreviewSchema.safeParse({ ...preview, capabilities: undefined })
      .success,
  ).toBe(false);
  expect(
    githubPluginPreviewSchema.safeParse({
      ...preview,
      trustedSource: undefined,
    }).success,
  ).toBe(false);
  const installation = {
    id: "a",
    version: null,
    source,
    pendingUpdate: null,
    integrity: "verified",
    trustedSource: false,
  };
  expect(pluginInstallationSchema.safeParse(installation).success).toBe(true);
  expect(
    pluginInstallationSchema.safeParse({
      ...installation,
      integrity: "unknown",
    }).success,
  ).toBe(false);
});
