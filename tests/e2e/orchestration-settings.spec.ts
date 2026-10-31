import { expect, test } from "@playwright/test";
import type { OrchestrationResponse } from "@covel/shared";
import { createRecoveryFixture } from "./execution-recovery-fixtures.js";
import { openStudioConfiguration } from "./helpers/player.js";

test.use({ viewport: { width: 1440, height: 1000 } });

test("policy choice and zero delegation caps survive reload and can be cleared", async ({
  page,
}) => {
  const fixture = await createRecoveryFixture(page, "completed");
  let value: OrchestrationResponse = {
    settings: { maxActors: 4, maxSubagentCalls: 16 },
    policies: [
      {
        pluginId: "conversation",
        name: "ensemble",
        label: "Conversation / Invite everyone",
        status: "available",
      },
      {
        pluginId: "conversation",
        name: "draw",
        label: "Conversation / Invite one character",
        status: "available",
      },
    ],
    status: "ambiguous",
  };
  let deny = false;
  await page.route(
    `**/api/sessions/${fixture.id}/orchestration`,
    async (route) => {
      if (route.request().method() === "PATCH") {
        if (deny)
          return route.fulfill({
            status: 403,
            json: { error: "Unauthorized" },
          });
        const patch = route.request().postDataJSON();
        value = { ...value, settings: { ...value.settings, ...patch } };
        if (patch.turnPolicy === null) delete value.settings.turnPolicy;
        value = {
          ...value,
          status: value.settings.turnPolicy ? "selected" : "ambiguous",
        };
      }
      await route.fulfill({ json: value });
    },
  );
  try {
    await page.goto(`/session?sid=${fixture.id}`);
    await openStudioConfiguration(page);
    const policy = page.getByLabel("回合策略", { exact: true });
    await expect(policy).toBeVisible();
    await expect(
      page.getByText("请选择策略以消除歧义", { exact: true }),
    ).toBeVisible();
    await policy.selectOption({ label: "Conversation / Invite one character" });
    await page
      .getByRole("button", { name: "保存回合策略", exact: true })
      .click();
    const actors = page.getByLabel("不同角色数（0–16）", { exact: true });
    await expect(actors).toBeEnabled();
    await actors.fill("0");
    await page
      .getByRole("button", { name: "保存不同角色数（0–16）", exact: true })
      .click();
    await expect.poll(() => value.settings.maxActors).toBe(0);
    await page.reload();
    await openStudioConfiguration(page);
    await expect(policy).toHaveValue(
      JSON.stringify({ pluginId: "conversation", name: "draw" }),
    );
    await expect(actors).toHaveValue("0");
    value = {
      ...value,
      status: "paused",
      policies: value.policies.map((item) =>
        item.name === "draw" ? { ...item, status: "paused" } : item,
      ),
    };
    await page.reload();
    await openStudioConfiguration(page);
    await expect(policy).toHaveValue(
      JSON.stringify({ pluginId: "conversation", name: "draw" }),
    );
    await expect(page.getByText("已暂停", { exact: true })).toBeVisible();
    await policy.selectOption("");
    await page
      .getByRole("button", { name: "保存回合策略", exact: true })
      .click();
    await expect(
      page.getByText("请选择策略以消除歧义", { exact: true }),
    ).toBeVisible();
    deny = true;
    await actors.fill("2");
    await page
      .getByRole("button", { name: "保存不同角色数（0–16）", exact: true })
      .click();
    await expect(
      page.getByRole("alert").filter({ hasText: "此项未能保存" }),
    ).toBeVisible();
    expect(value.settings.maxActors).toBe(0);
  } finally {
    await fixture.dispose();
  }
});
