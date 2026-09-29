import { expect, test } from "@playwright/test";
import { createRecoveryFixture } from "./execution-recovery-fixtures.js";

// Keep the host transport test independent of externally maintained demos.
const html = `<!doctype html><html><body>
  <button id="run" disabled>Run fixture</button>
  <textarea id="draft" aria-label="Draft"></textarea>
  <button id="oversize">Oversize draft</button><button id="clear">Clear draft</button>
  <pre id="cache-result"></pre>
  <pre id="state"></pre><pre id="result"></pre>
  <script>
    const run = document.getElementById("run");
    let hydrated = false;
    const draft = document.getElementById("draft");
    const cacheResult = document.getElementById("cache-result");
    async function cache(value) {
      try {
        await window.covel.invoke("setUiState", { value });
        cacheResult.textContent = "cached";
      } catch (error) {
        cacheResult.textContent = error.message;
      }
    }
    draft.oninput = () => cache({ text: draft.value });
    document.getElementById("oversize").onclick = () => cache({ text: "x".repeat(33000) });
    document.getElementById("clear").onclick = () => cache(null);
    window.covel.subscribe((state) => {
      if (state.locale && !hydrated) {
        hydrated = true;
        draft.value = state.uiState?.text ?? "";
      }
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
                  label: { en: "Webview Fixture", zh: "Webview Fixture" },
                  icon: "book-open",
                  alwaysRender: true,
                  dataSource: { namespace: "fixture" },
                  webview: { html, height: 300 },
                },
                {
                  label: { en: "Other Fixture", zh: "Other Fixture" },
                  alwaysRender: true,
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
    const frame = page
      .frameLocator('iframe[title="Webview Fixture"]')
      .frameLocator("iframe");
    await expect(frame.locator("#state")).toHaveText(
      JSON.stringify({ current: { value: "fixture state" } }),
    );
    expect(requests).toHaveLength(0);
    await frame
      .getByRole("textbox", { name: "Draft" })
      .fill("Retained draft 草稿");
    await expect(frame.locator("#cache-result")).toHaveText("cached");
    await frame.getByRole("button", { name: "Oversize draft" }).click();
    await expect(frame.locator("#cache-result")).toHaveText(
      "Plugin UI action failed",
    );
    await page.getByRole("tab", { name: "Other Fixture", exact: true }).click();
    await expect(page.locator('iframe[title="Webview Fixture"]')).toHaveCount(
      0,
    );
    const other = page
      .frameLocator('iframe[title="Other Fixture"]')
      .frameLocator("iframe");
    await expect(other.getByRole("textbox", { name: "Draft" })).toHaveValue("");
    await page
      .getByRole("tab", { name: "Webview Fixture", exact: true })
      .click();
    await expect(frame.getByRole("textbox", { name: "Draft" })).toHaveValue(
      "Retained draft 草稿",
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
    await frame.getByRole("button", { name: "Clear draft" }).click();
    await expect(frame.locator("#cache-result")).toHaveText("cached");
    await page.getByRole("tab", { name: "Other Fixture", exact: true }).click();
    await page
      .getByRole("tab", { name: "Webview Fixture", exact: true })
      .click();
    await expect(frame.getByRole("textbox", { name: "Draft" })).toHaveValue("");
  } finally {
    await fixture.dispose();
  }
});
