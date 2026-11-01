// @vitest-environment node
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { createStageRenderFixture } from "../helpers/stage-render-browser.js";
import { buildThirdPartyPluginZip } from "../helpers/third-party-package.js";

it("installs a zero-runtime theme through multipart admission and lists and serves it after restart without grants", async () => {
  const fixture = await createStageRenderFixture({
    narration: "Public reading story.",
  });
  try {
    const zip = await buildThirdPartyPluginZip(
      resolve(
        import.meta.dirname,
        "../../../../tests/third-party/theme-pack-probe",
      ),
    );
    const body = new FormData();
    body.append(
      "file",
      new Blob([new Uint8Array(zip)], { type: "application/zip" }),
      "theme-pack-probe.zip",
    );
    const installed = await fixture.app.request("/api/install/plugin", {
      method: "POST",
      body,
    });
    expect(installed.status, await installed.clone().text()).toBe(201);
    expect(await installed.json()).toMatchObject({
      id: "theme-pack-probe",
      hasServerCode: false,
    });
    await fixture.restart();
    const enabled = await fixture.app.request(
      `/api/sessions/${fixture.sessionId}/plugins/theme-pack-probe`,
      { method: "PUT" },
    );
    expect(enabled.status, await enabled.clone().text()).toBe(200);
    const response = await fixture.app.request(
      `/api/ui-specs?sessionId=${fixture.sessionId}`,
    );
    const result = await response.json();
    const theme = result.theme.find(
      (entry: { pluginId: string }) => entry.pluginId === "theme-pack-probe",
    )?.specs[0];
    expect(theme?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(theme?.cssText).toContain('[data-covel-theme-part="surface"]');
    const bitmap = await fixture.app.request(
      `/plugin-assets/theme-pack-probe/${theme.assets.digest}/paper.png`,
    );
    expect(bitmap.status).toBe(200);
    expect(bitmap.headers.get("content-type")).toBe("image/png");
    const plugins = await (
      await fixture.app.request(`/api/sessions/${fixture.sessionId}/plugins`)
    ).json();
    expect(
      plugins.items.find(
        (plugin: { id: string }) => plugin.id === "theme-pack-probe",
      ),
    ).toMatchObject({ active: true, executionMode: "declarative" });
    expect(
      JSON.stringify(await fixture.store.getSession(fixture.sessionId)),
    ).not.toContain("sessionTheme");
  } finally {
    await fixture.close();
  }
});
