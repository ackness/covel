import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PluginCapabilitiesPreview } from "../PluginCapabilitiesPreview.js";
import i18n from "@/i18n";
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(cleanup);
it.each([true, false])(
  "shows every capability and the source badge only when trusted=%s",
  (trustedSource) => {
    render(
      <PluginCapabilitiesPreview
        preview={{
          trustedSource,
          capabilities: {
            serverCode: true,
            http: [{ origin: "https://api.test", methods: ["GET"] }],
            hooks: [{ event: "PreToolUse", enforce: "pre" }],
            tools: ["read"],
            services: ["service@1"],
            actions: ["act"],
            wires: ["wire"],
            forms: ["form"],
            extensions: ["point@1/id"],
            datasets: [{ namespace: "notes", ops: ["set"] }],
          },
        }}
        update
      />,
    );
    expect(screen.getByText("Server code: Yes")).toBeTruthy();
    expect(screen.getByText(/HTTP origins: https:\/\/api.test/)).toBeTruthy();
    expect(screen.getByText("Hooks: PreToolUse (pre)")).toBeTruthy();
    expect(screen.getByText("Tools: read")).toBeTruthy();
    expect(screen.getByText("Plugin services: service@1")).toBeTruthy();
    expect(screen.getByText("Datasets: notes (set)")).toBeTruthy();
    expect(!!screen.queryByText("From a trusted source")).toBe(trustedSource);
    expect(
      screen.getByText(
        "New capabilities after an update will ask for approval again.",
      ),
    ).toBeTruthy();
  },
);

it("renders v2 instance, provider source, auth flow, and secret capabilities", () => {
  render(
    <PluginCapabilitiesPreview
      preview={{
        trustedSource: true,
        capabilities: {
          serverCode: true,
          instanceScope: true,
          providerSources: ["codex"],
          flows: ["oauth-sign-in", "device-sign-in"],
          appActions: ["list-accounts"],
          secrets: true,
          authProxy: true,
          loopbackCallback: { path: "/auth/callback", ports: [1455] },
          http: [{ origin: "https://auth.openai.com", methods: ["POST"] }],
          hooks: [],
          tools: [],
          services: [],
          actions: [],
          wires: [],
          forms: [],
          extensions: [],
          datasets: [],
        },
      }}
    />,
  );
  expect(screen.getByText("Instance scope: Yes")).toBeTruthy();
  expect(screen.getByText("Provider sources: codex")).toBeTruthy();
  expect(
    screen.getByText("Config / auth flows: oauth-sign-in, device-sign-in"),
  ).toBeTruthy();
  expect(screen.getByText("App actions: list-accounts")).toBeTruthy();
  expect(screen.getByText("Private secret vault: Yes")).toBeTruthy();
  expect(screen.getByText("Auth proxy network: Yes")).toBeTruthy();
  expect(
    screen.getByText("Loopback callback: /auth/callback (1455)"),
  ).toBeTruthy();
});
