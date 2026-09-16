import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  createRecoveryFixture,
  sourceTurnId,
} from "./execution-recovery-fixtures.js";
import check from "../../plugins/tabletop-rules/runtimes/check/handler.js";
import { createFormTool } from "../../packages/tools/src/builtin/ui-tools.js";
import { createMemoryStore } from "../../packages/store/src/index.js";
import { submitFormHandler } from "../../packages/runtime/src/rpc-defaults/submit-form.js";

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
    const store = createMemoryStore();
    const data = new Map<string, unknown>([
      [
        "setup/rules",
        {
          budget: 4,
          attributes: [{ id: "combat", label: "Combat", base: 1, max: 5 }],
        },
      ],
    ]);
    const context = {
      pluginId,
      sessionId: fixture.id,
      turnId: "ordinary",
      locale: "en-US",
      store,
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
    const spec = JSON.parse(
      (
        await readFile(
          new URL(
            "../../plugins/tabletop-rules/runtimes/check/ui/check-panel.json",
            import.meta.url,
          ),
          "utf8",
        )
      ).replaceAll("tabletop-rules", pluginId),
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
          return route.fulfill({
            json: { status: "ok", turnId: "opened", runtimeResults: [] },
          });
        }
        const result = await submitFormHandler(body.payload, {
          sessionId: fixture.id,
          pluginId: "framework",
          store,
        });
        return route.fulfill({ json: { status: "ok", result } });
      },
    );
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
      await page.reload();
      await expect(
        page.getByRole("textbox", { name: "Attempted action" }),
      ).toBeVisible();
      await expect(input).toBeDisabled();
      await page
        .getByRole("textbox", { name: "Attempted action" })
        .fill("Climb the harbor wall");
      await page
        .getByRole("combobox", { name: "Attribute", exact: true })
        .selectOption("combat");
      await page
        .getByRole("button", { name: "Resolve check", exact: true })
        .click();
      await expect.poll(() => fixture.actions.length).toBe(1);
      const settled = await check({ ...context, turnId: "settled" });
      expect(settled.value.receipt?.action).toBe("Climb the harbor wall");
      expect(settled.effects?.interactions ?? []).toEqual([]);
      form = undefined;
      await page.reload();
      await expect(input).toBeEnabled();
      await input.fill("Ask the guard about the harbor.");
      await expect(input).toHaveValue("Ask the guard about the harbor.");
    } finally {
      await fixture.dispose();
      await store.close();
    }
  });
}
