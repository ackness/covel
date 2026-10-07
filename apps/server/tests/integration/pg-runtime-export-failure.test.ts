import { afterAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { createPgStore } from "@covel/store/postgres";
import { finalizeExecution } from "@covel/runtime";
import type { RuntimeManifest } from "@covel/shared";
import { publishExecutionExports } from "../../../../packages/runtime/src/commit/runtime-export-publish.js";
import {
  makeSession,
  makeTurnResult,
} from "../../../../packages/store/src/contract/test-fixtures.js";
import { createIsolatedPgDatabase } from "./pg-test-db.js";
import { createPgEventTransport } from "../../src/lib/pg-event-transport.js";

let database: Awaited<ReturnType<typeof createIsolatedPgDatabase>> | undefined;
try {
  database = await createIsolatedPgDatabase(
    process.env.DATABASE_URL ??
      "postgresql://covel:covel_dev@localhost:5432/covel",
    "covel_export_failure_pg",
  );
} catch (cause) {
  if (process.env.COVEL_REQUIRE_PG_TESTS === "1")
    throw new Error("PostgreSQL is required for export failure tests", {
      cause,
    });
}
afterAll(() => database?.cleanup());

describe.skipIf(!database)("PostgreSQL export failure isolation", () => {
  it("preserves a finalized story and domain proposal when one real export INSERT fails", async () => {
    const store = await createPgStore(database!.url, { freshSchema: true });
    const sql = postgres(database!.url);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await sql.unsafe(`CREATE OR REPLACE FUNCTION reject_finalize_export() RETURNS trigger AS $$
        BEGIN
          IF NEW.producer_runtime_id = 'probe/broken' THEN
            RAISE EXCEPTION 'synthetic finalize export failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER reject_finalize_export BEFORE INSERT ON runtime_exports
        FOR EACH ROW EXECUTE FUNCTION reject_finalize_export();`);
      const sessionId = "finalize-session";
      const turnId = "finalize-turn";
      await store.createSession(makeSession({ id: sessionId }));
      await store.saveTurnResult(
        makeTurnResult({ id: turnId, turnId, sessionId }),
      );
      const runtimes = ["story", "broken", "healthy"].map(
        (id) =>
          ({
            name: `probe/${id}`,
            pluginId: "probe",
            description: "Fault probe",
            type: "function",
            pluginType: "plugin",
            outputKind: id === "story" ? "story" : "plugin",
            ...(id === "story"
              ? {}
              : { output: { recordAs: "probe@1", schema: "output.json" } }),
          }) as RuntimeManifest,
      );
      const outcome = await finalizeExecution({
        store,
        sessionId,
        executionContext: {
          executionId: turnId,
          origin: "player",
          countPolicy: "none",
        },
        runtimes,
        results: runtimes.map((runtime) => ({
          runtimeId: runtime.name,
          pluginId: "probe",
          runId: crypto.randomUUID(),
          turnId,
          status: "success" as const,
          output:
            runtime.outputKind === "story"
              ? { narrativeOutput: "A complete scene." }
              : { value: 7 },
          ...(runtime.name === "probe/healthy"
            ? {
                effects: {
                  statePatches: [{ table: "stats", field: "hp", value: 7 }],
                },
              }
            : {}),
        })),
        turnIds: [turnId],
        loadOutputSchema: async () => ({
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        }),
      });
      expect(outcome.status).toBe("committed");
      expect((await store.getStateEntry(sessionId, "stats", "hp"))?.value).toBe(
        7,
      );
      expect(
        (await store.listMessages(sessionId)).some(
          (message) => message.content === "A complete scene.",
        ),
      ).toBe(true);
      expect(
        (await store.queryTurnResults(sessionId, { turnId }))[0]?.commitStatus,
      ).toBe("committed");
      expect(
        (await store.listRuntimeExports(sessionId)).map(
          (row) => row.producerRuntimeId,
        ),
      ).toEqual(["probe/healthy"]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await Promise.all([store.close(), sql.end()]);
    }
  });
  it("delivers ordered notification frames across real clients and rejects writes after close", async () => {
    const sender = await createPgEventTransport(database!.url);
    const receiver = await createPgEventTransport(database!.url);
    const frames: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const received = new Promise<void>((resolve, reject) => {
      receiver.subscribe((frame) => {
        frames.push(frame);
        if (frames.length === 20) resolve();
      });
      timer = setTimeout(
        () =>
          reject(new Error("Timed out waiting for PostgreSQL notifications")),
        2_000,
      );
    });
    try {
      const expected = Array.from(
        { length: 20 },
        (_, index) => `synthetic-frame-${index}`,
      );
      for (const frame of expected) await sender.publish(frame);
      await received;
      expect(frames).toEqual(expected);
      await sender.close();
      await expect(sender.publish("after-close")).rejects.toBeDefined();
    } finally {
      clearTimeout(timer);
      await Promise.all([sender.close(), receiver.close()]);
    }
  });
  it("rolls back a failed export statement while committing domain writes and later exports", async () => {
    const store = await createPgStore(database!.url, { freshSchema: true });
    const sql = postgres(database!.url);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await sql.unsafe(`CREATE FUNCTION reject_broken_export() RETURNS trigger AS $$
        BEGIN
          IF NEW.producer_runtime_id = 'probe/broken' THEN
            RAISE EXCEPTION 'synthetic export persistence failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER reject_broken_export BEFORE INSERT ON runtime_exports
        FOR EACH ROW EXECUTE FUNCTION reject_broken_export();`);
      await store.createSession(makeSession({ id: "export-session" }));
      await store.saveTurnResult(
        makeTurnResult({
          id: "export-turn",
          turnId: "export-turn",
          sessionId: "export-session",
        }),
      );
      const publish = (
        sink: Parameters<typeof publishExecutionExports>[0]["sink"],
      ) =>
        publishExecutionExports({
          sink,
          sessionId: "export-session",
          results: [
            {
              status: "success",
              runtimeId: "probe/broken",
              resultId: "broken",
              output: { value: 1 },
            },
            {
              status: "success",
              runtimeId: "probe/healthy",
              resultId: "healthy",
              output: { value: 2 },
            },
          ],
          declFor: () => ({
            pluginId: "probe",
            pluginVersion: "1.0.0",
            recordAs: "probe@1",
          }),
          loadOutputSchema: async () => ({
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
          }),
          committedAt: "2026-10-07T00:00:00.000Z",
        });

      // A caught SQL error still aborts PostgreSQL's enclosing transaction.
      await expect(
        store.withTransaction(async (tx) => {
          await publish({
            getLatestRuntimeExport: tx.getLatestRuntimeExport,
            appendRuntimeExport: tx.appendRuntimeExport,
          });
          await tx.setTurnResultCommitStatus(
            "export-session",
            "export-turn",
            "committed",
          );
        }),
      ).rejects.toMatchObject({ cause: { code: "25P02" } });
      expect(
        (
          await store.queryTurnResults("export-session", {
            turnId: "export-turn",
          })
        )[0]?.commitStatus,
      ).toBe("pending");

      await store.withTransaction(async (tx) => {
        await tx.setPluginData({
          id: "domain",
          sessionId: "export-session",
          pluginId: "probe",
          namespace: "state",
          key: "hp",
          value: 7,
          createdAt: "2026-10-07T00:00:00.000Z",
          updatedAt: "2026-10-07T00:00:00.000Z",
        });
        await publish(tx);
        await tx.setTurnResultCommitStatus(
          "export-session",
          "export-turn",
          "committed",
        );
      });
      expect(
        (
          await store.queryTurnResults("export-session", {
            turnId: "export-turn",
          })
        )[0]?.commitStatus,
      ).toBe("committed");
      expect(
        (await store.getPluginData("export-session", "probe", "state", "hp"))
          ?.value,
      ).toBe(7);
      expect(
        (await store.listRuntimeExports("export-session")).map(
          (row) => row.producerRuntimeId,
        ),
      ).toEqual(["probe/healthy"]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await Promise.all([store.close(), sql.end()]);
    }
  });
});
