import { expect, test } from "@playwright/test";
import {
  createRecoveryFixture,
  sourceTurnId,
} from "./execution-recovery-fixtures.js";

// The package API test covers authoritative validation; this checks the real browser submit/retry path.
for (const width of [1512, 390]) {
  test(`numeric form keeps types and remains editable after rejection at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await createRecoveryFixture(page, "completed");
    const snapshot = await (
      await page.request.get(`/api/sessions/${fixture.id}/view`)
    ).json();
    const submissions: Array<Record<string, unknown>> = [];
    let authorized = false;
    const decisions: string[] = [];
    await page.route(
      "**/api/approvals/restored-form/decision",
      async (route) => {
        const { decision } = route.request().postDataJSON();
        decisions.push(decision);
        authorized = decision === "allow";
        await route.fulfill({ json: { ok: true, decision, scope: "session" } });
      },
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const form = {
      type: "interactive_form",
      interactionId: "allocation",
      title: "Point allocation",
      submitLabel: "Allocate points",
      fields: [
        {
          type: "number",
          name: "strength",
          label: "Strength",
          min: 0,
          max: 5,
          step: 1,
          defaultValue: 0,
          required: true,
        },
        {
          type: "number",
          name: "agility",
          label: "Agility",
          min: 0,
          max: 5,
          step: 1,
          defaultValue: 0,
          required: true,
        },
        {
          type: "checkbox",
          name: "ready",
          label: "Ready",
          defaultValue: false,
        },
      ],
      meta: { turnId: sourceTurnId },
    };
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
              id: "allocation-message",
              role: "assistant",
              content: "",
              kind: "system",
              turnId: sourceTurnId,
              block: form,
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        },
      }),
    );
    await page.route(
      `**/api/sessions/${fixture.id}/plugin-rpc`,
      async (route) => {
        const body = route.request().postDataJSON();
        if (body.action !== "submit-form") return route.fallback();
        if (!authorized)
          return route.fulfill({
            status: 202,
            json: {
              status: "approval-required",
              approvalId: "restored-form",
              pending: {
                sessionId: fixture.id,
                pluginId: "third-party-form",
                action: "covel:plugin-server-code",
              },
            },
          });
        const values = body.payload.submissions[0].values;
        submissions.push(values);
        if (values.strength + values.agility !== 4) {
          return route.fulfill({
            status: 400,
            json: { error: "Allocate exactly 4 points" },
          });
        }
        return route.fulfill({
          json: {
            status: "ok",
            result: {
              accepted: true,
              results: [
                {
                  interactionId: "allocation",
                  submissionId: "accepted",
                  accepted: true,
                  filledNarrative: "Character ready",
                },
              ],
            },
          },
        });
      },
    );
    try {
      await page.goto(`/session?sid=${fixture.id}`);
      const strength = page.getByRole("spinbutton", { name: "Strength" });
      const agility = page.getByRole("spinbutton", { name: "Agility" });
      const submit = page.getByRole("button", { name: "Allocate points" });
      await expect(strength).toHaveValue("0");
      await strength.fill("3");
      await agility.fill("3");
      await submit.click();
      await page.getByRole("button", { name: /^(Deny|拒绝)$/ }).click();
      await expect.poll(() => decisions).toEqual(["deny"]);
      await expect(strength).toHaveValue("3");
      await expect(submit).toBeEnabled();
      expect(submissions).toHaveLength(0);
      expect(fixture.actions).toHaveLength(0);
      await expect(
        page.getByText(/^(出错了|Something went wrong)$/),
      ).toHaveCount(0);
      await submit.click();
      await page.getByRole("button", { name: /^(Authorize|授权)$/ }).click();
      await expect.poll(() => decisions).toEqual(["deny", "allow"]);
      await expect.poll(() => submissions.length).toBe(1);
      expect(submissions[0]).toEqual({ strength: 3, agility: 3, ready: false });
      await expect(strength).toBeEnabled();
      await expect(submit).toBeEnabled();
      expect(fixture.actions).toHaveLength(0);
      await agility.fill("1");
      await page.getByRole("checkbox", { name: "Ready" }).check();
      await submit.click();
      await expect.poll(() => submissions.length).toBe(2);
      expect(submissions[1]).toEqual({ strength: 3, agility: 1, ready: true });
      await expect.poll(() => fixture.actions.length).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });
}
