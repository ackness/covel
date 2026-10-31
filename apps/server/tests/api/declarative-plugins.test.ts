import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseDocument, type Document } from "yaml";
import {
  apiListResponseSchema,
  pluginSummarySchema,
  readRuntimeEnv,
  type LLMAdapter,
  type SessionSnapshot,
} from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { deriveHostProfile } from "../../src/host-profile.js";
import { closeTestApi } from "../helpers/close-api.js";
import { parseJsonFrames } from "./sse-test-utils.js";
import { sessionApprovalScope } from "../../src/routes/api/session/session-guard.js";

const id = "declarative-notebook";
const source = path.resolve(
  import.meta.dirname,
  "../../../../tests/third-party/declarative-notebook",
);
let root: string;
let directory: string;
let api: ApiBootstrapResult | undefined;
let sessionId: string;
let ownerToken: string;
const defaultGenerate: LLMAdapter["generate"] = async (params) => {
  const answered = params.messages.some((message) => message.role === "tool");
  return {
    content: null,
    toolCalls: [
      {
        id: answered ? "done" : "note",
        name: answered ? "runtime-done" : "notes-upsert",
        arguments: JSON.stringify(
          answered
            ? {}
            : { record: { id: "harbor", text: "We reached the harbor." } },
        ),
      },
    ],
    finishReason: "tool_calls",
    usage: { inputTokens: 5, outputTokens: 5 },
  };
};
const generate = vi.fn(defaultGenerate);
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "covel-declarative-api-"));
  directory = path.join(root, "user", id);
  await cp(source, directory, { recursive: true });
  await mkdir(path.join(root, "builtin"));
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DEPLOYMENT_TIER", "self");
  vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "");
  vi.stubEnv("COVEL_TRUSTED_SOURCES", "");
  vi.stubEnv("COVEL_USER_PLUGINS_DIR", path.join(root, "user"));
  generate.mockReset().mockImplementation(defaultGenerate);
});
afterEach(async () => {
  await closeTestApi(api);
  api = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function manifest(change: (config: Document) => void) {
  const file = path.join(directory, "PLUGIN.md");
  const text = await readFile(file, "utf8");
  const [, frontmatter, body] = text.split(/^---\s*$/m);
  const config = parseDocument(frontmatter!);
  change(config);
  await writeFile(file, `---\n${config.toString()}---\n${body}`);
}
function request(
  url: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return api!.app.request(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-session-token": ownerToken ?? "",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function build(hosted = false, selected = false) {
  if (hosted) {
    vi.stubEnv("DEPLOYMENT_TIER", "demo");
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "operator");
  }
  api = await bootstrapApi({
    pluginsDir: path.join(root, "builtin"),
    pluginsDirs: [path.join(root, "builtin"), path.join(root, "user")],
    store: createMemoryStore(),
    storeBackend: "memory",
    hostProfile: deriveHostProfile(readRuntimeEnv(), {
      storeBackend: "sqlite",
    }),
    llmAdapter: { generate },
    canRunRuntimeJobWithServerServices: () => true,
  });
  api!.app.get("/__declarative-approvals", async (c) => {
    const session = await api!.store.getSession(sessionId);
    return c.json({
      code: c
        .get("rpcApprovalGate")
        .hasGrant(
          sessionId,
          id,
          "covel:plugin-server-code",
          sessionApprovalScope(session!, id),
        ),
      runtime: c
        .get("rpcApprovalGate")
        .hasGrant(
          sessionId,
          id,
          `runtime:${id}`,
          sessionApprovalScope(session!, id),
        ),
      pending: c.get("rpcApprovalGate").listAllPendingForSession(sessionId),
    });
  });
  const created = await request(
    "/api/sessions",
    "POST",
    { locale: "en-US", plugins: selected ? [id] : [] },
    hosted ? { authorization: "Bearer operator" } : {},
  );
  expect(created.status, await created.clone().text()).toBe(201);
  const body = await created.json();
  sessionId = body.id;
  ownerToken = body.ownerToken;
}
const enable = () => request(`/api/sessions/${sessionId}/plugins/${id}`, "PUT");
const reload = () =>
  request(`/api/plugins/${id}/reload`, "POST", { sessionId });
const run = () =>
  request("/api/actions", "POST", {
    requestId: crypto.randomUUID(),
    sessionId,
    type: "submit_actions",
    payload: { actions: [{ kind: "say", text: "We reached the harbor." }] },
  });
async function listed() {
  const response = await request(`/api/sessions/${sessionId}/plugins`);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()).items.find(
    (item: { id: string }) => item.id === id,
  );
}
async function assertNoGrants() {
  const session = await api!.store.getSession(sessionId);
  expect(session).toBeDefined();
  // Read the real gate through host composition; an exemption must not mint grants.
  expect(await (await request("/__declarative-approvals")).json()).toEqual({
    code: false,
    runtime: false,
    pending: [],
  });
}
it.each([false, true])(
  "enables and commits own data without provenance or synthetic grants (selected=%s)",
  async (selected) => {
    await build(false, selected);
    const discovery = apiListResponseSchema(pluginSummarySchema).parse(
      await (await request("/api/plugins")).json(),
    );
    expect(discovery.items).toContainEqual(
      expect.objectContaining({
        id,
        source: "community",
        executionMode: "declarative",
        trust: {
          source: null,
          trustedSource: false,
          integrity: "no-receipt",
          autoApproved: false,
        },
      }),
    );
    expect((await enable()).status).toBe(200);
    expect(await listed()).toMatchObject({
      executionMode: "declarative",
      active: true,
      serverCodeApproved: false,
      approvalRequired: false,
    });
    expect((await listed()).serverCodeApprovedBy).toBeUndefined();
    const response = await run();
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const frames = parseJsonFrames<{
      type: string;
      payload: Record<string, unknown>;
    }>(text);
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "execution.completed",
        payload: expect.objectContaining({ committed: true }),
      }),
    );
    expect(generate).toHaveBeenCalled();
    expect(
      (await api!.store.listTurnResults(sessionId)).at(-1)?.commitStatus,
    ).toBe("committed");
    expect(
      (await api!.store.getPluginData(sessionId, id, "notes", "harbor"))?.value,
    ).toEqual({ id: "harbor", text: "We reached the harbor." });
    const restored = await request(`/api/sessions/${sessionId}/view`);
    expect(restored.status, await restored.clone().text()).toBe(200);
    const snapshot = (await restored.json()) as SessionSnapshot;
    expect(snapshot.session.completedPlayerTurns).toBe(1);
    expect(snapshot.messages).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: "We reached the harbor.",
      }),
    );
    await assertNoGrants();
    expect(
      (await request(`/api/sessions/${sessionId}/plugins/${id}`, "DELETE"))
        .status,
    ).toBe(200);
    expect((await enable()).status).toBe(200);
  },
);
it("allows the hosted session owner and rejects another owner without opening code access", async () => {
  await build(true);
  expect((await enable()).status).toBe(200);
  expect(
    (
      await request(
        `/api/sessions/${sessionId}/plugins/${id}`,
        "PUT",
        undefined,
        { "x-session-token": "wrong" },
      )
    ).status,
  ).toBe(401);
  const turn = await run();
  expect(turn.status, await turn.text()).toBe(200);
  await writeFile(
    path.join(directory, "entry.js"),
    "throw new Error('must not import');",
  );
  expect((await enable()).status).toBe(401);
  expect((await listed()).executionMode).toBe("code");
});
it("quarantines a code upgrade, then restores declarative eligibility after removal", async () => {
  await build();
  expect((await enable()).status).toBe(200);
  const sentinel = path.join(root, "imported.txt");
  await mkdir(path.join(directory, "server"));
  await writeFile(
    path.join(directory, "server/index.js"),
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "imported"); export default () => {};`,
  );
  expect((await reload()).status).toBe(200);
  expect(await listed()).toMatchObject({
    executionMode: "code",
    approvalRequired: true,
    serverCodeApproved: false,
  });
  await expect(readFile(sentinel)).rejects.toThrow();
  const pending = await enable();
  expect(pending.status).toBe(202);
  const { approvalId } = await pending.json();
  expect(
    (
      await request(`/api/approvals/${approvalId}/decision`, "POST", {
        decision: "allow",
        scope: "session",
      })
    ).status,
  ).toBe(200);
  expect(await readFile(sentinel, "utf8")).toBe("imported");
  await rm(path.join(directory, "server"), { recursive: true });
  expect((await reload()).status).toBe(200);
  expect((await listed()).executionMode).toBe("declarative");
  expect(
    (await request(`/api/sessions/${sessionId}/plugins/${id}`, "DELETE"))
      .status,
  ).toBe(200);
  expect((await enable()).status).toBe(200);
  await assertNoGrants();
});
it("expires stale code approval requests without storing a grant", async () => {
  await writeFile(path.join(directory, "test.js"), "// distribution code");
  await build();
  const pending = await enable();
  expect(pending.status).toBe(202);
  const { approvalId } = await pending.json();
  await rm(path.join(directory, "test.js"));
  expect((await reload()).status).toBe(200);
  expect(
    (
      await request(`/api/approvals/${approvalId}/decision`, "POST", {
        decision: "allow",
        scope: "session",
      })
    ).status,
  ).toBe(409);
  expect((await enable()).status).toBe(200);
  await assertNoGrants();
});
it("executes an explicit manual runtime without a runtime grant", async () => {
  await manifest((config) => {
    config.setIn(["runtime", "schedule"], { trigger: { type: "manual" } });
  });
  await build();
  expect((await enable()).status).toBe(200);
  const response = await request(
    `/api/sessions/${sessionId}/plugin-rpc`,
    "POST",
    { kind: "runtime", pluginId: id, runtimeId: id, payload: {} },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  expect(
    (await api!.store.getPluginData(sessionId, id, "notes", "harbor"))?.value,
  ).toBeDefined();
  await assertNoGrants();
});
it("publishes a zero-runtime view without a model call or code grant", async () => {
  await manifest((config) => {
    config.delete("runtime");
  });
  await build();
  expect((await enable()).status).toBe(200);
  expect(await listed()).toMatchObject({
    executionMode: "declarative",
    runtimeCount: 0,
    hostState: "loaded",
  });
  expect(generate).not.toHaveBeenCalled();
  await assertNoGrants();
});

const toolReply = (
  name: string,
  args: object,
): Awaited<ReturnType<LLMAdapter["generate"]>> => ({
  content: null,
  toolCalls: [
    { id: crypto.randomUUID(), name, arguments: JSON.stringify(args) },
  ],
  finishReason: "tool_calls",
  usage: { inputTokens: 2, outputTokens: 2 },
});
it("commits validated character records through a declared framework tool", async () => {
  await manifest((config) =>
    config.setIn(["runtime", "agent", "tools", "builtin"], ["sync-characters"]),
  );
  generate.mockResolvedValueOnce(
    toolReply("sync-characters", { creates: [{ name: "Mara", type: "npc" }] }),
  );
  await build(false, true);
  const response = await run();
  expect(response.status, await response.text()).toBe(200);
  expect(await api!.store.listCharacters(sessionId)).toContainEqual(
    expect.objectContaining({ name: "Mara", type: "npc" }),
  );
  expect(
    (await api!.store.listTurnResults(sessionId)).at(-1)?.commitStatus,
  ).toBe("committed");
  await assertNoGrants();
});
it("rejects malformed and foreign dataset writes while committing a valid own record", async () => {
  generate.mockResolvedValueOnce(
    toolReply("notes-upsert", { record: { id: "invalid", text: 7 } }),
  );
  generate.mockResolvedValueOnce(
    toolReply("notes-upsert", {
      pluginId: "other",
      namespace: "_hidden.notes",
      record: { id: "foreign", text: "must not persist" },
    }),
  );
  generate.mockResolvedValueOnce(
    toolReply("notes-upsert", {
      record: { id: "valid", text: "Public notebook record" },
    }),
  );
  await build(false, true);
  const response = await run();
  expect(response.status, await response.text()).toBe(200);
  expect(
    (await api!.store.listPluginData(sessionId, id, "notes")).map(
      (row) => row.key,
    ),
  ).toEqual(["valid"]);
  expect(
    await api!.store.listPluginData(sessionId, "other", "_hidden.notes"),
  ).toEqual([]);
  const answers = JSON.stringify(
    generate.mock.calls.flatMap(([params]) =>
      params.messages.filter((message) => message.role === "tool"),
    ),
  );
  expect(answers).toContain("invalid-input");
  expect(answers).toContain("Staged:");
});
it("keeps an optional write provider independently approved and attributes its committed writes", async () => {
  const provider = "notebook-review-provider";
  const providerDir = path.join(root, "user", provider);
  const sentinel = path.join(root, "provider-imported.txt");
  await mkdir(providerDir);
  await writeFile(
    path.join(providerDir, "PLUGIN.md"),
    `---
entry: ./entry.js
description: Reviews a note.
contributes:
  services: [{ contract: notebook.review@1, access: write, modelFacing: true }]
---
`,
  );
  await writeFile(
    path.join(providerDir, "entry.js"),
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(sentinel)}, "imported");
export default c => { c.registerService({ name: "review", contract: "notebook.review@1", access: "write", modelFacing: true, description: "Review a note", input: c.toolkit.z.object({ text: c.toolkit.z.string() }), output: c.toolkit.z.object({ reviewed: c.toolkit.z.boolean() }), handler: async ({ text }, ctx) => { await ctx.pluginData.update("reviews", "latest", [{ op: "set", value: { text } }]); return { reviewed: true }; } }); };`,
  );
  await build(false, true);
  let response = await run();
  expect(response.status, await response.text()).toBe(200);
  expect(
    generate.mock.calls[0]?.[0].tools?.map((tool) => tool.name),
  ).not.toContain("review-note");
  await expect(readFile(sentinel)).rejects.toThrow();
  const pending = await request(
    `/api/sessions/${sessionId}/plugins/${provider}`,
    "PUT",
  );
  expect(pending.status).toBe(202);
  const { approvalId } = await pending.json();
  expect(
    (
      await request(`/api/approvals/${approvalId}/decision`, "POST", {
        decision: "allow",
        scope: "session",
      })
    ).status,
  ).toBe(200);
  expect(
    (await request(`/api/sessions/${sessionId}/plugins/${provider}`, "PUT"))
      .status,
  ).toBe(200);
  expect(await readFile(sentinel, "utf8")).toBe("imported");
  generate.mockClear();
  generate.mockResolvedValueOnce(
    toolReply("review-note", { text: "Public review" }),
  );
  response = await run();
  expect(response.status, await response.text()).toBe(200);
  expect(generate.mock.calls[0]?.[0].tools?.map((tool) => tool.name)).toContain(
    "review-note",
  );
  expect(
    (await api!.store.getPluginData(sessionId, provider, "reviews", "latest"))
      ?.value,
  ).toEqual({ text: "Public review" });
  expect(
    await api!.store.getPluginData(sessionId, id, "reviews", "latest"),
  ).toBeNull();
  await assertNoGrants();
});

it.each(["", "en/"])(
  "executes the exact documented notebook through public admission and commit (%s)",
  async (edition) => {
    const guide = await readFile(
      path.resolve(
        import.meta.dirname,
        `../../../../docs/${edition}plugins/prompt-only.md`,
      ),
      "utf8",
    );
    const files = [
      ...guide.matchAll(
        /<!-- notebook-file:([^ ]+) -->\s+```[^\n]+\n([\s\S]*?)\n```/g,
      ),
    ];
    expect(files).toHaveLength(6);
    await rm(directory, { recursive: true });
    for (const [, name, text] of files) {
      const file = path.join(directory, name!);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text!);
    }
    await build(false, true);
    const response = await run();
    expect(response.status, await response.text()).toBe(200);
    expect(
      (await api!.store.getPluginData(sessionId, id, "notes", "harbor"))?.value,
    ).toMatchObject({ text: "We reached the harbor." });
    await assertNoGrants();
  },
);
it("keeps event consent while running a declarative subscriber without code or runtime grants", async () => {
  await writeFile(
    path.join(directory, "schemas/opened.json"),
    JSON.stringify({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
  );
  await manifest((config) => {
    config.setIn(
      ["contributes", "events"],
      [
        {
          topic: "notebook.opened",
          schema: "./schemas/opened.json",
          description: "The notebook was opened.",
        },
      ],
    );
    config.setIn(["runtime", "schedule"], {
      trigger: { type: "event", topic: "notebook.opened" },
    });
    config.setIn(
      ["runtime", "agent", "tools", "datasets"],
      [{ dataset: "notes", tools: ["list"] }],
    );
  });
  generate.mockResolvedValueOnce(toolReply("runtime-done", {}));
  await build(false, true);
  const emit = () =>
    request(`/api/sessions/${sessionId}/plugin-rpc`, "POST", {
      kind: "event",
      pluginId: id,
      topic: "notebook.opened",
      payload: {},
    });
  const pending = await emit();
  expect(pending.status, await pending.clone().text()).toBe(202);
  const { approvalId, pending: approval } = await pending.json();
  expect(approval.action).toBe("event:notebook.opened");
  expect(generate).not.toHaveBeenCalled();
  expect(
    (
      await request(`/api/approvals/${approvalId}/decision`, "POST", {
        decision: "allow",
        scope: "session",
      })
    ).status,
  ).toBe(200);
  const response = await emit();
  expect(response.status, await response.clone().text()).toBe(200);
  expect((await response.json()).deferredJobs).toHaveLength(1);
  await vi.waitFor(async () =>
    expect(
      (await api!.store.listTurnResults(sessionId)).some(
        (turn) => turn.commitStatus === "committed",
      ),
    ).toBe(true),
  );
  expect(generate).toHaveBeenCalled();
  await assertNoGrants();
});
it.each([false, true])(
  "rechecks declarative eligibility on the real resume route (code upgrade=%s)",
  async (upgrade) => {
    await manifest((config) =>
      config.setIn(["runtime", "agent", "tools", "builtin"], ["suspend"]),
    );
    generate.mockResolvedValueOnce(
      toolReply("suspend", {
        reason: "Which note?",
        fields: [{ type: "text", name: "note", label: "Note" }],
      }),
    );
    await build(false, true);
    const first = await run();
    expect(first.status, await first.text()).toBe(200);
    const [suspension] = await api!.store.listSuspensions(sessionId);
    expect(suspension).toBeDefined();
    if (upgrade)
      await writeFile(
        path.join(directory, "new-code.js"),
        "throw new Error('unapproved');",
      );
    const response = await request(
      `/api/sessions/${sessionId}/suspensions/${suspension!.id}/resume`,
      "POST",
      { data: { note: "Harbor" } },
    );
    expect(response.status, await response.clone().text()).toBe(
      upgrade ? 202 : 200,
    );
    if (upgrade) {
      const { pending } = await response.json();
      expect(pending.action).toBe("covel:plugin-server-code");
      expect(generate).toHaveBeenCalledOnce();
    } else {
      expect(await response.json()).toMatchObject({
        result: { status: "success" },
      });
      expect(generate.mock.calls.length).toBeGreaterThan(1);
      await assertNoGrants();
    }
  },
);

it("does not admit an enable paused across a code publication using the old proof", async () => {
  await build();
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const refresh = api!.trustedSources.ensureFresh;
  vi.spyOn(api!.trustedSources, "ensureFresh").mockImplementationOnce(
    async (candidate) => {
      await refresh(candidate);
      reached.resolve();
      await release.promise;
    },
  );
  const enabling = enable();
  await reached.promise;
  const sentinel = path.join(root, "raced-import.txt");
  try {
    await mkdir(path.join(directory, "server"));
    await writeFile(
      path.join(directory, "server/index.js"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "imported"); export default () => {};`,
    );
    expect((await reload()).status).toBe(200);
  } finally {
    release.resolve();
  }
  expect((await enabling).status).toBe(202);
  await expect(readFile(sentinel)).rejects.toThrow();
  expect(await listed()).toMatchObject({
    executionMode: "code",
    serverCodeApproved: false,
  });
});

it("admits a separate declarative sub-agent and conceals its failure through the parent continuation", async () => {
  const helper = "notebook-helper";
  const helperRoot = path.join(root, "user", helper);
  await mkdir(helperRoot);
  await writeFile(
    path.join(helperRoot, "PLUGIN.md"),
    `---
description: Optional private helper.
runtime:
  schedule: { subagentOnly: true }
  io:
    concealed: true
    output: { contract: notebook.helper@1 }
  agent:
    loop: { maxSteps: 2 }
---
HIDDEN-PROVIDER-PROMPT
`,
  );
  await manifest((config) =>
    config.setIn(["runtime", "agent", "tools", "builtin"], ["delegate"]),
  );
  const failure = "CONCEALED-FAILURE-SENTINEL";
  const toolAnswers: string[] = [];
  generate.mockImplementation(async (params) => {
    if (
      params.messages.some(
        (message) =>
          message.role === "system" &&
          String(message.content).includes("HIDDEN-PROVIDER-PROMPT"),
      )
    )
      throw new Error(failure);
    const answers = params.messages.filter(
      (message) => message.role === "tool",
    );
    toolAnswers.push(JSON.stringify(answers));
    if (!answers.length)
      return toolReply("delegate", {
        target: { contract: "notebook.helper@1" },
        brief: "Give a short public suggestion.",
      });
    if (answers.length === 1)
      return toolReply("notes-upsert", {
        record: { id: "survives", text: "The notebook still works." },
      });
    return toolReply("runtime-done", {});
  });
  await build(false, true);
  expect(
    (await request(`/api/sessions/${sessionId}/plugins/${helper}`, "PUT"))
      .status,
  ).toBe(200);
  expect((await listed()).executionMode).toBe("declarative");
  const response = await run();
  const stream = await response.text();
  expect(response.status, stream).toBe(200);
  expect(
    (await api!.store.getPluginData(sessionId, id, "notes", "survives"))?.value,
  ).toMatchObject({ text: "The notebook still works." });
  expect(
    generate.mock.calls.some(([params]) =>
      params.messages.some((message) =>
        String(message.content).includes("HIDDEN-PROVIDER-PROMPT"),
      ),
    ),
  ).toBe(true);
  expect(toolAnswers.join("\n")).toContain("error");
  const publicSurfaces = JSON.stringify({
    stream,
    toolAnswers,
    results: await api!.store.listTurnResults(sessionId),
    messages: await api!.store.listMessages(sessionId),
  });
  expect(publicSurfaces).not.toContain(failure);
  expect(publicSurfaces).not.toContain("HIDDEN-PROVIDER-PROMPT");
  expect(publicSurfaces).toContain("The notebook still works.");
  await assertNoGrants();
});

it("retains freshly declarative content and its data when forking without inheriting grants", async () => {
  await build(false, true);
  const response = await run();
  expect(response.status, await response.text()).toBe(200);
  const snapshot = await request(
    `/api/sessions/${sessionId}/snapshots`,
    "POST",
  );
  expect(snapshot.status, await snapshot.clone().text()).toBe(201);
  const { id: snapshotId } = await snapshot.json();
  const fork = await request(`/api/sessions/${sessionId}/fork`, "POST", {
    fromSnapshotId: snapshotId,
  });
  expect(fork.status, await fork.clone().text()).toBe(201);
  const body = await fork.json();
  const childId = body.sessionId;
  expect((await api!.store.getSession(childId))?.activePlugins).toContain(id);
  expect(
    (await api!.store.getPluginData(childId, id, "notes", "harbor"))?.value,
  ).toMatchObject({ text: "We reached the harbor." });
  const childPlugins = await request(
    `/api/sessions/${childId}/plugins`,
    "GET",
    undefined,
    { "x-session-token": body.ownerToken },
  );
  expect((await childPlugins.json()).items).toContainEqual(
    expect.objectContaining({
      id,
      executionMode: "declarative",
      active: true,
      serverCodeApproved: false,
      approvalRequired: false,
    }),
  );
  const approvals = await request(
    `/api/sessions/${childId}/approvals`,
    "GET",
    undefined,
    { "x-session-token": body.ownerToken },
  );
  expect((await approvals.json()).items).toEqual([]);
});

it.each(["function", "guard"])(
  "quarantines a new %s that references a previously browser-only directory",
  async (field) => {
    await build(false, true);
    const sentinel = path.join(root, "handler-imported.txt");
    await writeFile(
      path.join(directory, "ui/page/server.js"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "imported"); export default () => ({ outcome: "success", value: {} });`,
    );
    await manifest((config) => {
      if (field === "guard")
        config.setIn(["runtime", "guard"], "./ui/page/server.js");
      else {
        config.deleteIn(["runtime", "agent"]);
        config.setIn(["runtime", "function"], {
          handler: "./ui/page/server.js",
        });
      }
    });
    expect((await reload()).status).toBe(200);
    expect((await listed()).executionMode).toBe("code");
    const response = await run();
    expect(response.status, await response.clone().text()).toBe(202);
    expect((await response.json()).pending.action).toBe(
      "covel:plugin-server-code",
    );
    await expect(readFile(sentinel)).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
  },
);
it("runs an empty session while leaving unselected declarative packages disabled", async () => {
  await build();
  const response = await run();
  expect(response.status, await response.text()).toBe(200);
  expect(generate).not.toHaveBeenCalled();
  expect((await listed()).active).toBe(false);
  await assertNoGrants();
});

it("installs a clean ZIP without a receipt and admits it after the required host restart", async () => {
  const { default: yazl } = await import("yazl");
  const { readPackageInventory } = await import("@covel/plugin-loader");
  const inventory = await readPackageInventory(source);
  const zip = new yazl.ZipFile();
  const zipped = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
  for (const file of inventory.files)
    zip.addBuffer(Buffer.from(file.content), `${id}/${file.relativePath}`);
  zip.end();
  await rm(directory, { recursive: true });
  await build();
  const form = new FormData();
  form.set(
    "file",
    new File([new Uint8Array(await zipped)], "notebook.zip", {
      type: "application/zip",
    }),
  );
  const installed = await api!.app.request("/api/install/plugin", {
    method: "POST",
    body: form,
  });
  expect(installed.status, await installed.clone().text()).toBe(201);
  expect(await installed.json()).toMatchObject({
    id,
    hasServerCode: false,
    restartRequired: true,
  });
  await expect(
    readFile(path.join(directory, ".covel-install.json")),
  ).rejects.toThrow();
  await closeTestApi(api);
  api = undefined;
  await build(false, true);
  expect(await listed()).toMatchObject({
    executionMode: "declarative",
    active: true,
    trust: { integrity: "no-receipt", autoApproved: false },
  });
  const response = await run();
  expect(response.status, await response.text()).toBe(200);
  expect(
    (await api!.store.getPluginData(sessionId, id, "notes", "harbor"))?.value,
  ).toBeDefined();
  await assertNoGrants();
});
