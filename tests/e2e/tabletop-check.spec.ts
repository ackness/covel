import { fileURLToPath } from "node:url";
import {
  loadPluginUiSpec,
  readMessageCatalogs,
} from "../../packages/plugin-loader/src/index.js";
import { pluginMessagesFor } from "../../packages/shared/src/index.js";
import { expect, test } from "@playwright/test";
import {
  createRecoveryFixture,
  sourceTurnId,
} from "./execution-recovery-fixtures.js";
import check from "../../plugins/tabletop-rules/runtimes/check/handler.js";
import { createFormTool } from "../../packages/tools/src/builtin/ui-tools.js";
import { createMemoryStore } from "../../packages/store/src/memory-entry.js";
import { createInteractionSubmitter } from "../../packages/runtime/src/interaction/interaction-submission.js";
import { actionStreamBody } from "./helpers/action-stream.js";
import { makeRandom } from "../../packages/plugin-test-utils/src/manual-context.js";

// API tests exercise ZIP installation, authorization and durable commits. Here the
// real plugin handler and form validator feed the browser without a live model.
for (const width of [1512, 390]) {
  test(`tabletop checks only block input after an explicit request at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await createRecoveryFixture(page, "completed");
    const snapshot = await (
      await page.request.get(`/api/sessions/${fixture.id}/view`)
    ).json();
    const pluginId = "tabletop-probe";
    const pluginRoot = fileURLToPath(
      new URL("../../plugins/tabletop-rules/", import.meta.url),
    );
    const locale = snapshot.session.locale;
    const messages = pluginMessagesFor(
      await readMessageCatalogs(pluginRoot),
      locale,
    );
    const store = createMemoryStore();
    const submitInteraction = createInteractionSubmitter(undefined, store);
    const data = new Map<string, unknown>([
      [
        "setup/rules",
        {
          budget: 4,
          attributes: [{ id: "combat", label: "战斗", base: 1, max: 5 }],
        },
      ],
    ]);
    const context = {
      pluginId,
      sessionId: fixture.id,
      turnId: "ordinary",
      locale,
      messages,
      random: makeRandom(),
      store: { listPlayerInputs: () => store.listPlayerInputs(fixture.id) },
      pluginData: {
        get: async (ns: string, key: string) => data.get(`${ns}/${key}`),
        set: async (ns: string, key: string, value: unknown) => {
          data.set(`${ns}/${key}`, value);
        },
      },
      tools: {
        call: async (name: string, args: Record<string, unknown>) => {
          if (name === "list-characters")
            return { characters: [{ id: "player", fields: { combat: 3 } }] };
          return createFormTool.execute(args, {
            sessionId: fixture.id,
            pluginId,
            runtimeId: `${pluginId}/check`,
            turnId: "opened",
          });
        },
      },
    };
    let form: Record<string, unknown> | undefined;
    let opened = false;
    const openedForm = Promise.withResolvers<void>();
    let delivered = false;
    await page.route("**/api/events/stream?*", async (route) => {
      await openedForm.promise;
      if (delivered)
        return route.fulfill({
          contentType: "text/event-stream",
          body: ": connected\n\n",
        });
      delivered = true;
      const event = {
        id: "committed-form",
        type: "interaction.requested",
        topic: "state",
        sessionId: fixture.id,
        timestamp: "2026-01-01T00:01:00Z",
        payload: {
          turnId: "opened",
          block: {
            id: "check-form",
            type: "interactive_form",
            data: form,
            meta: { turnId: "opened" },
          },
        },
      };
      await route.fulfill({
        contentType: "text/event-stream",
        body: `event: interaction.requested\ndata: ${JSON.stringify(event)}\n\n`,
      });
    });
    const loadedSpec = await loadPluginUiSpec(
      pluginRoot,
      `${pluginRoot}/runtimes/check/ui/check-panel.json`,
      "tabletop-rules",
    );
    const spec = JSON.parse(
      JSON.stringify(loadedSpec).replaceAll("tabletop-rules", pluginId),
    );
    await page.route("**/api/ui-specs?*", (route) =>
      route.fulfill({
        json: { right: [{ pluginId, specs: [spec] }], left: [], message: [] },
      }),
    );
    await page.route(
      `**/api/sessions/${fixture.id}/plugin-data/${pluginId}**`,
      (route) => route.fulfill({ json: { items: [] } }),
    );
    await page.route(`**/api/sessions/${fixture.id}/view`, (route) =>
      route.fulfill({
        json: {
          ...snapshot,
          session: {
            ...snapshot.session,
            phase: "playing",
            completedPlayerTurns: 1,
          },
          execution: { state: "completed", turnId: sourceTurnId },
          messages: [
            {
              id: "story",
              role: "assistant",
              kind: "story",
              turnId: sourceTurnId,
              content: "The harbor is quiet.",
              createdAt: "2026-01-01T00:00:00Z",
            },
            ...(form
              ? [
                  {
                    id: "check-form",
                    role: "assistant",
                    kind: "system",
                    content: "",
                    turnId: "opened",
                    block: {
                      ...form,
                      type: "interactive_form",
                      meta: { turnId: "opened" },
                    },
                    createdAt: "2026-01-01T00:01:00Z",
                  },
                ]
              : []),
          ],
        },
      }),
    );
    await page.route(
      `**/api/sessions/${fixture.id}/plugin-rpc`,
      async (route) => {
        const body = route.request().postDataJSON();
        if (body.kind === "runtime") {
          expect(body.runtimeId).toBe(`${pluginId}/check`);
          const output = await check({
            ...context,
            turnId: "opened",
            manualPayload: body.payload,
          });
          form = output.effects?.interactions[0];
          expect(form).toBeDefined();
          await store.appendTurnMessage({
            id: "template",
            sessionId: fixture.id,
            turnId: "opened",
            sourceType: "runtime",
            sourcePluginId: pluginId,
            role: "assistant",
            content: "",
            order: 1,
            pendingInput: [form],
            createdAt: new Date().toISOString(),
          });
          opened = true;
          openedForm.resolve();
          return route.fulfill({
            json: { status: "ok", turnId: "opened", runtimeResults: [] },
          });
        }
        return route.fallback();
      },
    );
    // The answer and its follow-up turn are one action. Registered after the
    // fixture's own stub, so it sees the request first.
    let answered = 0;
    await page.route("**/api/actions", async (route) => {
      const body = route.request().postDataJSON();
      if (body.type !== "submit_interaction") return route.fallback();
      const prepared = await submitInteraction(body.payload, {
        sessionId: fixture.id,
      });
      await prepared.persist(store);
      answered += 1;
      return route.fulfill({
        contentType: "text/event-stream",
        body: actionStreamBody(body, "settled", [
          [
            "interaction.submitted",
            {
              interactionTurnId: prepared.turnId,
              results: prepared.results,
              ...(prepared.playerMessage
                ? {
                    message: {
                      id: "check-answer",
                      content: prepared.playerMessage,
                    },
                  }
                : {}),
            },
          ],
          ["execution.started", { status: "executing", runtimeCount: 0 }],
          ["execution.completed", { committed: true, runtimeCount: 0 }],
        ]),
      });
    });
    try {
      for (const turnId of ["ordinary", "another"]) {
        const output = await check({ ...context, turnId });
        expect(output.effects?.interactions ?? []).toEqual([]);
      }
      await page.goto(`/session?sid=${fixture.id}`);
      const input = page.getByTestId("game-composer-input");
      await expect(input).toBeEnabled();
      const request = page.getByRole("button", {
        name: /发起属性检定|Request an attribute check/,
      });
      if (width < 1024)
        await page
          .getByRole("button", { name: "切换状态与世界上下文" })
          .click();
      await page.getByRole("tab", { name: "属性检定", exact: true }).click();
      await request.click({ timeout: 5_000 });
      await expect.poll(() => opened).toBe(true);
      if (width < 1024)
        await page
          .getByRole("button", { name: /关闭|Close/, exact: true })
          .click();
      await expect(
        page.getByRole("textbox", { name: "尝试的行动" }),
      ).toBeVisible();
      await expect(input).toBeDisabled();
      await page.reload();
      await expect(
        page.getByRole("textbox", { name: "尝试的行动" }),
      ).toBeVisible();
      await page
        .getByRole("textbox", { name: "尝试的行动" })
        .fill("Climb the harbor wall");
      await page
        .getByRole("combobox", { name: "属性", exact: true })
        .selectOption("combat");
      await page.getByRole("button", { name: "进行检定", exact: true }).click();
      await expect.poll(() => answered).toBe(1);
      expect(fixture.actions).toHaveLength(0);
      const settled = await check({ ...context, turnId: "settled" });
      expect(settled.value.receipt?.action).toBe("Climb the harbor wall");
      expect(settled.effects?.interactions ?? []).toEqual([]);
      form = undefined;
      await page.reload();
      await expect(input).toBeEnabled();
      await input.fill("Ask the guard about the harbor.");
      await expect(input).toHaveValue("Ask the guard about the harbor.");
    } finally {
      openedForm.resolve();
      await fixture.dispose();
      await store.close();
    }
  });
}
