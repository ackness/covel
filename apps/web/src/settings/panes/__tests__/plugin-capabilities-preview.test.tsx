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
    expect(screen.getByText("Service contracts: service@1")).toBeTruthy();
    expect(screen.getByText("Datasets: notes (set)")).toBeTruthy();
    expect(!!screen.queryByText("From a trusted source")).toBe(trustedSource);
    expect(
      screen.getByText(
        "New capabilities after an update will ask for approval again.",
      ),
    ).toBeTruthy();
  },
);
