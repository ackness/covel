import { describe, it, expect } from "vitest";
import { createServiceGateway } from "../src/service-gateway.js";
import { createRecordQueryService } from "../src/record-query-service.js";
import { createTableService } from "../src/table-service.js";
import { createApprovalService } from "../src/approval-service.js";
import { createTraceService } from "../src/trace-service.js";
import { createRuntimeSettingsService } from "../src/runtime-settings-service.js";
import { createToolGatewayService } from "../src/tool-gateway-service.js";
import { createToolRegistry } from "@covel/plugin-manager";

describe("RecordQueryService", () => {
  it("should publish and query records", async () => {
    const svc = createRecordQueryService();
    svc.publish({
      recordType: "runtime_result",
      pluginId: "core-dice",
      runtimeId: "dice-roll",
      sessionId: "s1",
      turnId: "t1",
      runId: "r1",
      traceId: "tr1",
      status: "success",
      timestamp: new Date().toISOString(),
      locale: "zh-CN",
      payload: { total: 10 },
    });

    const result = await svc.query({ sessionId: "s1" });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].pluginId).toBe("core-dice");
  });

  it("should filter by status", async () => {
    const svc = createRecordQueryService();
    svc.publish({
      recordType: "runtime_result", pluginId: "p1", runtimeId: "r1",
      sessionId: "s1", turnId: "t1", runId: "r1", traceId: "tr1",
      status: "success", timestamp: "", locale: "en-US", payload: {},
    });
    svc.publish({
      recordType: "runtime_result", pluginId: "p1", runtimeId: "r1",
      sessionId: "s1", turnId: "t2", runId: "r2", traceId: "tr2",
      status: "failed", timestamp: "", locale: "en-US", payload: {},
    });

    const result = await svc.query({ sessionId: "s1", status: ["failed"] });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].status).toBe("failed");
  });

  it("should paginate with cursor", async () => {
    const svc = createRecordQueryService();
    for (let i = 0; i < 5; i++) {
      svc.publish({
        recordType: "runtime_result", pluginId: "p1", runtimeId: "r1",
        sessionId: "s1", turnId: `t${i}`, runId: `r${i}`, traceId: `tr${i}`,
        status: "success", timestamp: "", locale: "en-US", payload: { i },
      });
    }

    const page1 = await svc.query({ sessionId: "s1", limit: 2 });
    expect(page1.records).toHaveLength(2);
    expect(page1.nextCursor).toBe("2");

    const page2 = await svc.query({ sessionId: "s1", limit: 2, cursor: page1.nextCursor });
    expect(page2.records).toHaveLength(2);
  });
});

describe("TableService", () => {
  it("should create table and write/read", async () => {
    const svc = createTableService();
    svc.createTable("core-states.character", "core-states");

    await svc.write({
      action: "upsert",
      table: "core-states.character",
      key: "hero",
      data: { name: "Hero", hp: 100 },
      callerPluginId: "core-states",
    });

    const result = await svc.query({
      mode: "latest",
      table: "core-states.character",
      callerPluginId: "core-states",
      allowedPatterns: ["core-states.*"],
    });
    expect(result).toHaveLength(1);
  });

  it("should enforce declared read patterns", async () => {
    const svc = createTableService();
    svc.createTable("core-states.character", "core-states");

    await svc.write({
      action: "upsert",
      table: "core-states.character",
      key: "hero",
      data: { name: "Hero" },
      callerPluginId: "core-states",
    });

    const result = await svc.query({
      mode: "latest",
      table: "core-states.character",
      callerPluginId: "other-plugin",
      allowedPatterns: ["other-plugin.*"],
    });

    expect(result).toEqual({
      error: 'Plugin "other-plugin" cannot read table "core-states.character".',
    });
  });

  it("should enforce ownership on write", async () => {
    const svc = createTableService();
    svc.createTable("core-states.character", "core-states");

    const result = await svc.write({
      action: "upsert",
      table: "core-states.character",
      key: "hero",
      data: { name: "Hero" },
      callerPluginId: "other-plugin",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot write");
  });

  it("should patch schema with history", async () => {
    const svc = createTableService();
    svc.createTable("test.table", "test");

    const result = await svc.patchSchema({
      table: "test.table",
      patch: { newField: { type: "string" } },
      callerPluginId: "test",
      callerRuntimeId: "rt1",
      runId: "run1",
    });

    expect(result.success).toBe(true);
    expect(result.newSchema).toHaveProperty("newField");
  });

  it("should reject incompatible schema changes", async () => {
    const svc = createTableService();
    svc.createTable("test.table", "test", {
      hp: { type: "integer" },
    });

    const result = await svc.patchSchema({
      table: "test.table",
      patch: { hp: { type: "string" } },
      callerPluginId: "test",
      callerRuntimeId: "rt1",
      runId: "run1",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Incompatible");
  });
});

describe("ApprovalService", () => {
  it("should auto-approve whitelisted plugins", async () => {
    const svc = createApprovalService(new Set(["core-narrator"]));

    const decision = await svc.check({
      sessionId: "s1",
      pluginId: "core-narrator",
      toolId: "any-tool",
    });
    expect(decision.allowed).toBe(true);
  });

  it("should deny non-whitelisted plugins", async () => {
    const svc = createApprovalService(new Set(["core-narrator"]));

    const decision = await svc.check({
      sessionId: "s1",
      pluginId: "third-party",
      toolId: "web.search",
    });
    expect(decision.allowed).toBe(false);
  });

  it("should remember grants", async () => {
    const svc = createApprovalService();

    await svc.grant({ sessionId: "s1", pluginId: "plugin-a", toolId: "tool-1" });
    const decision = await svc.check({ sessionId: "s1", pluginId: "plugin-a", toolId: "tool-1" });
    expect(decision.allowed).toBe(true);
  });
});

describe("TraceService", () => {
  it("should append and retrieve entries", async () => {
    const svc = createTraceService();

    await svc.append({
      kind: "runtime_start",
      sessionId: "s1", turnId: "t1", runId: "r1",
      traceId: "tr1", pluginId: "p1", runtimeId: "rt1",
      timestamp: "", data: {},
    });

    expect(svc.getAll()).toHaveLength(1);
    expect(svc.getBySession("s1")).toHaveLength(1);
    expect(svc.getByTraceId("tr1")).toHaveLength(1);
  });
});

describe("RuntimeSettingsService", () => {
  it("should get and update settings", async () => {
    const svc = createRuntimeSettingsService();

    const initial = await svc.getResolved("s1", "p1", "rt1");
    expect(initial).toEqual({});

    await svc.update("s1", "p1", "rt1", { trackingDetail: "detailed" });
    const updated = await svc.getResolved("s1", "p1", "rt1");
    expect(updated.trackingDetail).toBe("detailed");
  });
});

describe("ServiceGateway", () => {
  it("should create gateway with all services", () => {
    const gw = createServiceGateway();
    expect(gw.records).toBeDefined();
    expect(gw.tables).toBeDefined();
    expect(gw.scripts).toBeDefined();
    expect(gw.references).toBeDefined();
    expect(gw.approvals).toBeDefined();
    expect(gw.tools).toBeDefined();
    expect(gw.settings).toBeDefined();
    expect(gw.trace).toBeDefined();
  });
});

describe("ToolGatewayService", () => {
  it("should list only allowed tools for a runtime", async () => {
    const registry = createToolRegistry();
    registry.setRuntimeImports("consumer", "main", ["provider.shared"]);
    registry.register({
      qualifiedId: "provider.shared",
      pluginId: "provider",
      runtimeId: "shared-runtime",
      toolId: "shared",
      exported: true,
      description: "Shared tool",
      execute: async () => ({ ok: true }),
    });

    const approvals = createApprovalService(new Set(["consumer"]));
    const trace = createTraceService();
    const gateway = createToolGatewayService({ registry, approvals, trace });
    const tools = await gateway.listAvailable("main", "consumer");

    expect(tools).toHaveLength(1);
    expect(tools[0].qualifiedId).toBe("provider.shared");
  });

  it("should return an interaction id when approval is required", async () => {
    const registry = createToolRegistry();
    registry.register({
      qualifiedId: "provider.shared",
      pluginId: "provider",
      runtimeId: "shared-runtime",
      toolId: "shared",
      exported: true,
      execute: async () => ({ ok: true }),
    });

    const approvals = createApprovalService();
    const trace = createTraceService();
    const gateway = createToolGatewayService({ registry, approvals, trace });
    const result = await gateway.invoke({
      qualifiedToolId: "provider.shared",
      input: {},
      callerPluginId: "third-party",
      callerRuntimeId: "main",
      sessionId: "s1",
      turnId: "t1",
      traceId: "tr1",
      locale: "zh-CN",
    });

    expect(result.success).toBe(false);
    expect(result.interactionId).toBe("approval:s1:third-party:provider.shared");
  });
});
