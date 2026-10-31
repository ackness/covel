import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Proposal } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => ({ remote: { address: "127.0.0.1" } }),
}));
const pluginId = "sandbox-surface-probe";
const at = "2026-10-31T00:00:00.000Z";
const frames = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map(
      (line) =>
        JSON.parse(line.slice(6)) as {
          type: string;
          payload: Record<string, unknown>;
        },
    );
let root: string;
let boot: ApiBootstrapResult;
let store: ReturnType<typeof createMemoryStore>;
let sessionId: string;
let serial = 0;
let rejectOperation = false;
const headers = {
  "content-type": "application/json",
  authorization: "Bearer sandbox-test",
};
const request = (url: string, method = "GET", body?: unknown) =>
  boot.app.request(url, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
async function approve(url: string, method: string, body?: unknown) {
  for (let count = 0; count < 5; count++) {
    const response = await request(url, method, body);
    if (response.status !== 202) return response;
    const pending = (await response.json()) as { approvalId: string };
    const decision = await request(
      `/api/approvals/${pending.approvalId}/decision`,
      "POST",
      { decision: "allow", scope: "session" },
    );
    expect(decision.status, await decision.clone().text()).toBe(200);
  }
  throw new Error("Approval did not settle");
}
const action = (actions: unknown[]) =>
  request("/api/actions", "POST", {
    requestId: `request-${++serial}`,
    sessionId,
    type: "submit_actions",
    payload: { actions },
  });
beforeEach(async () => {
  vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "sandbox-test");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("COVEL_INSTRUCTION_LOCALE", "en");
  root = await mkdtemp(path.join(tmpdir(), "sandbox-session-"));
  const builtin = path.join(root, "builtin");
  const user = path.join(root, "community");
  await mkdir(path.join(builtin, "story"), { recursive: true });
  await mkdir(user);
  await cp(
    path.resolve(
      import.meta.dirname,
      "../../../../tests/third-party/sandbox-surface-probe",
    ),
    path.join(user, pluginId),
    { recursive: true },
  );
  await mkdir(path.join(builtin, "story/runtimes/story"), { recursive: true });
  await mkdir(path.join(builtin, "story/runtimes/child"), { recursive: true });
  await mkdir(path.join(builtin, "bank/server"), { recursive: true });
  await writeFile(
    path.join(builtin, "story/PLUGIN.md"),
    "---\nid: story\ndescription: Deterministic public story\n---\n",
  );
  await writeFile(
    path.join(builtin, "story/runtimes/story/RUNTIME.md"),
    "---\ndescription: Public story\nschedule: {stage: narrative}\nio:\n  visibility: story\n  output: {contract: narrative-engine@2}\nfunction: {}\n---\n",
  );
  await writeFile(
    path.join(builtin, "story/runtimes/story/handler.js"),
    `export default async function (ctx) {
    if (ctx.playerMessage === "Compose with services") {
      await ctx.recursiveCall({manualTrigger: {runtimeId: "story/child"}});
      await ctx.services.call({pluginId:"bank",name:"write",contract:"probe.write@1",input:{key:"independent"}});
    }
    return {outcome:"success",value:{segments:[{kind:"narration",text:"The public story continues."}]}};
  }`,
  );
  await writeFile(
    path.join(builtin, "story/runtimes/child/RUNTIME.md"),
    "---\ndescription: Nested service caller\nschedule:\n  trigger: {type: manual}\nfunction: {}\n---\n",
  );
  await writeFile(
    path.join(builtin, "story/runtimes/child/handler.js"),
    `export default async function(ctx) { await ctx.services.call({pluginId:"bank",name:"write",contract:"probe.write@1",input:{key:"refused"}}); return {outcome:"success",value:{done:true}}; }`,
  );
  await writeFile(
    path.join(builtin, "bank/PLUGIN.md"),
    "---\nid: bank\ndescription: Test write service\ncontributes:\n  services: [{contract: probe.write@1, access: write}]\n---\n",
  );
  await writeFile(
    path.join(builtin, "bank/server/index.js"),
    `export default function(covel) { const {z}=covel.toolkit; covel.registerService({name:"write",contract:"probe.write@1",access:"write",input:z.object({key:z.string()}),output:z.object({done:z.boolean()}),async handler({key},ctx) { await ctx.pluginData.set("notes",key,{done:true}); return {done:true}; }}); }`,
  );
  rejectOperation = false;
  store = createMemoryStore();
  boot = await bootstrapApi({
    pluginsDir: builtin,
    pluginsDirs: [builtin, user],
    covelHome: root,
    store,
    storeBackend: "memory",
    perRequestMiddleware: [
      async (c, next) => {
        const hooks = c.get("hookPipeline");
        if (!hooks) throw new Error("Missing hook pipeline");
        hooks.register<{ proposal: Proposal }>({
          id: "refuse-operation",
          pluginId: "bank",
          event: "PreStateCommit",
          handler: async (_ctx, { proposal }) =>
            rejectOperation &&
            (proposal.payload as { key?: string }).key === "refused"
              ? { action: "abort", reason: "The operation was refused" }
              : { action: "continue" },
        });
        await next();
      },
    ],
    llmAdapter: {
      generate: async () => {
        throw new Error("Function fixture must not call a model");
      },
    },
  });
  const created = await request("/api/sessions", "POST", {
    locale: "en-US",
    plugins: ["story", "bank"],
  });
  expect(created.status, await created.clone().text()).toBe(201);
  sessionId = ((await created.json()) as { id: string }).id;
  const enabled = await approve(
    `/api/sessions/${sessionId}/plugins/${pluginId}`,
    "PUT",
  );
  expect(enabled.status, await enabled.clone().text()).toBe(200);
  // The public character association is test setup; action provenance is always
  // resolved by the normal route from these seats and characters.
  await store.upsertCharacter({
    id: "hero",
    sessionId,
    name: "Hero",
    type: "player",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  await store.updateSession(sessionId, { phase: "playing" });
});
afterEach(async () => {
  if (boot && sessionId) await request(`/api/sessions/${sessionId}/ui-slots`);
  await closeTestApi(boot);
  await store?.close();
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("consented sandbox requests through normal server routes", () => {
  it("loads the real community declarations and commits its own manual proposal, refusing forbidden dataset operations", async () => {
    const entry = boot.registry.get(pluginId)!;
    expect(entry.source).toBe("community");
    expect(entry.packageManifest?.manifest.ui?.view).toHaveLength(2);
    const url = `/api/sessions/${sessionId}/plugin-rpc`;
    const body = {
      kind: "runtime",
      pluginId,
      runtimeId: `${pluginId}/write`,
      payload: { text: "Persisted from the page" },
    };
    const response = await approve(url, "POST", body);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      runtimeResults: [{ runtimeId: `${pluginId}/write`, status: "success" }],
    });
    const saved = await store.listPluginData(sessionId, pluginId, "notes");
    expect(saved).toHaveLength(1);
    expect(saved[0]?.value).toEqual({
      id: "bridge",
      text: "Persisted from the page",
    });
    boot.registry.register({
      ...boot.registry.get(pluginId)!,
      datasets: { notes: { ...entry.datasets!.notes!, ops: ["inc"] } },
    });
    const refused = await approve(url, "POST", {
      ...body,
      payload: { text: "Must not persist" },
    });
    expect(refused.status, await refused.clone().text()).toBe(500);
    expect(await refused.json()).toMatchObject({ code: "turn_commit_failed" });
    expect(await store.listPluginData(sessionId, pluginId, "notes")).toEqual(
      saved,
    );
  });
  it("keeps the story and an independent operation when a nested service write is refused", async () => {
    rejectOperation = true;
    const response = await action([
      { kind: "say", text: "Compose with services" },
    ]);
    expect(response.status).toBe(200);
    const stream = frames(await response.text());
    expect(stream).toContainEqual(
      expect.objectContaining({
        type: "execution.completed",
        payload: expect.objectContaining({ committed: true }),
      }),
    );
    expect(
      stream.filter((event) => event.type === "operation.failed"),
    ).toHaveLength(1);
    expect(
      (await store.listMessages(sessionId)).some((row) =>
        row.content.includes("The public story continues."),
      ),
    ).toBe(true);
    expect(
      await store.getPluginData(sessionId, "bank", "notes", "refused"),
    ).toBeNull();
    expect(
      (await store.getPluginData(sessionId, "bank", "notes", "independent"))
        ?.value,
    ).toEqual({ done: true });
    const results = await store.listTurnResults(sessionId);
    expect(results.length).toBeGreaterThan(0);
    expect(results.map((result) => result.commitStatus)).toEqual(
      results.map(() => "committed"),
    );
  });
  it("commits a host-shaped player action with server-derived seat, actor and source", async () => {
    const response = await action([
      { kind: "say", text: "Open the gate", seatId: "main" },
    ]);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(frames(await response.text())).toContainEqual(
      expect.objectContaining({
        type: "execution.completed",
        payload: expect.objectContaining({ committed: true }),
      }),
    );
    const rows = (await store.listMessages(sessionId)).filter(
      (row) => row.role === "user",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      content: "Open the gate",
      metadata: {
        actions: [
          {
            kind: "say",
            text: "Open the gate",
            seatId: "main",
            actorId: "hero",
            source: "player",
          },
        ],
      },
    });
  });
  it.each([
    [{ kind: "say", text: "forged", seatId: "foreign" }, "seat_not_found", 404],
    [{ kind: "narrate", text: "forged" }, "action_kind_not_allowed", 409],
    [
      { kind: "say", text: "forged", actorId: "foreign" },
      "actor_not_bound",
      409,
    ],
    [{ kind: "say", text: "forged", source: "system" }, undefined, 400],
  ])(
    "refuses forged player authority without persisting input: %j",
    async (body, code, status) => {
      const response = await action([body]);
      const text = await response.text();
      expect(response.status).toBe(status);
      if (code) expect(text).toContain(String(code));
      else expect(response.status).toBe(400);
      expect(
        (await store.listMessages(sessionId)).filter(
          (row) => row.role === "user",
        ),
      ).toEqual([]);
      expect((await store.getSession(sessionId))?.completedPlayerTurns).toBe(0);
    },
  );
  it("refuses a non-human seat without input or state changes", async () => {
    await store.updateSession(sessionId, {
      seats: [
        { id: "main", controller: "empty", role: "player", characters: "auto" },
      ],
    });
    const before = await store.getSession(sessionId);
    const response = await action([
      { kind: "say", text: "Uncontrolled", seatId: "main" },
    ]);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "seat_not_human" });
    expect(
      (await store.listMessages(sessionId)).filter(
        (row) => row.role === "user",
      ),
    ).toEqual([]);
    expect(await store.getSession(sessionId)).toEqual(before);
  });
  it.each(["form", "choice", "confirmation"] as const)(
    "persists one valid %s answer and exactly one follow-up",
    async (type) => {
      const asked = await approve(
        `/api/sessions/${sessionId}/plugin-rpc`,
        "POST",
        {
          kind: "runtime",
          pluginId,
          runtimeId: `${pluginId}/write`,
          payload: { ask: type },
        },
      );
      expect(asked.status, await asked.clone().text()).toBe(200);
      const question = (await store.listTurnMessages(sessionId)).find(
        (row) => Array.isArray(row.pendingInput) && row.pendingInput.length > 0,
      );
      expect(question).toBeDefined();
      const values =
        type === "form"
          ? { route: "Left" }
          : type === "choice"
            ? { selectedId: "left" }
            : { confirmed: true };
      const answer = {
        kind: type === "choice" ? "say" : "act",
        interaction: {
          turnId: question!.turnId,
          interactionId:
            type === "form"
              ? "bridge-form"
              : type === "choice"
                ? "bridge-choice"
                : "bridge-confirmation",
          type,
        },
        fields: values,
      };
      const invalid = await action([{ ...answer, fields: {} }]);
      expect(await invalid.text()).toContain(
        type === "form" ? "form_rejected" : "invalid_interaction_submission",
      );
      const valid = await action([answer]);
      const stream = frames(await valid.text());
      expect(
        stream.filter((event) => event.type === "interaction.submitted"),
      ).toHaveLength(1);
      expect(
        stream.filter((event) => event.type === "execution.started"),
      ).toHaveLength(1);
      expect(stream).toContainEqual(
        expect.objectContaining({
          type: "execution.completed",
          payload: expect.objectContaining({ committed: true }),
        }),
      );
      const before = await store.listMessages(sessionId);
      const duplicate = await action([answer]);
      expect(await duplicate.text()).toContain("interaction_already_submitted");
      expect(await store.listMessages(sessionId)).toEqual(before);
    },
  );
});
