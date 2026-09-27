import { expect, test } from "@playwright/test";
import { createRecoveryFixture } from "./execution-recovery-fixtures.js";

// Keep the host transport test independent of externally maintained demos.
const html = `<!doctype html><html><body>
  <button id="run" disabled>Run fixture</button>
  <pre id="state"></pre><pre id="result"></pre>
  <script>
    const run = document.getElementById("run");
    window.covel.subscribe((state) => {
      run.disabled = !state.locale || state.locked;
      document.getElementById("state").textContent = JSON.stringify(state.data);
    });
    run.onclick = async () => {
      const result = document.getElementById("result");
      result.textContent = "pending";
      try {
        result.textContent = JSON.stringify(await window.covel.invoke("invokeRuntime", {
          runtimeId: "webview-action-fixture/run", payload: { value: "fixture input" }
        }));
      } catch (error) {
        result.textContent = error.message;
      }
    };
  </script>
</body></html>`;

test("package webview receives runtime outcomes and sanitized transport errors", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await createRecoveryFixture(page, "completed");
  const pluginId = "webview-action-fixture";
  const runtimeId = `${pluginId}/run`;
  const mask = `**/api/sessions/${fixture.id}`;
  const requests: unknown[] = [];
  let outcome: "success" | "failed" | "transport-error" = "success";
  try {
    const directory = await (
      await page.request.get(`/api/sessions/${fixture.id}/plugins`)
    ).json();
    await page.route(`${mask}/plugins`, (route) =>
      route.fulfill({
        json: {
          ...directory,
          items: [
            ...directory.items,
            {
              id: pluginId,
              displayName: "Webview Fixture",
              description: "Synthetic host bridge consumer",
              pluginType: "plugin",
              active: true,
              locked: false,
              source: "community",
              status: "registered",
              runtimeCount: 1,
              runtimes: [],
              tools: [],
              userSettings: [],
              capabilities: [],
              tags: [],
            },
          ],
        },
      }),
    );
    await page.route("**/api/ui-specs?**", (route) =>
      route.fulfill({
        json: {
          right: [
            {
              pluginId,
              specs: [
                {
                  id: "fixture-panel",
                  label: "Webview Fixture",
                  icon: "book-open",
                  alwaysRender: true,
                  dataSource: { namespace: "fixture" },
                  webview: { html, height: 300 },
                },
              ],
            },
          ],
          left: [],
          message: [],
        },
      }),
    );
    await page.route(`${mask}/plugin-data/${pluginId}{,/**}`, (route) =>
      route.fulfill({
        json: {
          items: [
            {
              namespace: "fixture",
              key: "current",
              value: { value: "fixture state" },
            },
          ],
        },
      }),
    );
    await page.route(`${mask}/plugin-rpc`, (route) => {
      requests.push(route.request().postDataJSON());
      if (outcome === "transport-error") {
        return route.fulfill({
          status: 500,
          json: { error: "Synthetic server detail" },
        });
      }
      return route.fulfill({
        json: {
          status: "ok",
          runtimeResults: [
            {
              runtimeId,
              pluginId,
              status: outcome,
              durationMs: 1,
              output:
                outcome === "success" ? { value: "fixture output" } : null,
            },
          ],
        },
      });
    });
    await page.goto(`/session?sid=${fixture.id}`);
    await page.getByRole("button", { name: "切换状态与世界上下文" }).click();
    await page
      .getByRole("tab", { name: "Webview Fixture", exact: true })
      .click();
    const frame = page.frameLocator('iframe[title="Webview Fixture"]');
    await expect(frame.locator("#state")).toHaveText(
      JSON.stringify({ current: { value: "fixture state" } }),
    );
    expect(requests).toHaveLength(0);
    await frame.getByRole("button", { name: "Run fixture" }).click();
    await expect(frame.locator("#result")).toContainText(
      '"value":"fixture output"',
    );
    expect(requests).toEqual([
      {
        kind: "runtime",
        pluginId,
        runtimeId,
        payload: { value: "fixture input" },
      },
    ]);

    outcome = "failed";
    await frame.getByRole("button", { name: "Run fixture" }).click();
    await expect(frame.locator("#result")).toContainText('"status":"failed"');

    outcome = "transport-error";
    await frame.getByRole("button", { name: "Run fixture" }).click();
    await expect(frame.locator("#result")).toHaveText(
      "Plugin UI action failed",
    );
    expect(requests).toHaveLength(3);
  } finally {
    await fixture.dispose();
  }
});
