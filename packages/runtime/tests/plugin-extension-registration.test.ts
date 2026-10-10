import { describe, expect, it } from "vitest";
import { promptSegmentV1 } from "@covel/shared";
import type { ExtensionDeclaration } from "@covel/shared";
import type { ExtensionPointHandler } from "@covel/plugin-handlers-utils";
import { PluginServiceRegistry } from "../src/plugin-services.js";
import { PluginExtensionHost } from "../src/plugin-extensions.js";
import { PluginEntryScope } from "../src/plugin-entry-scope.js";
import { createExtensionRegistration } from "../src/plugin-extension-registration.js";

const declaration = {
  point: "prompt.history-transform@1",
  id: "history",
} as const;
const handler: ExtensionPointHandler<"prompt.history-transform@1"> = async (
  input,
) => ({ messages: input.messages });

describe("extension declaration publication", () => {
  function fixture(
    declarations: readonly ExtensionDeclaration[] = [declaration],
  ) {
    const host = new PluginExtensionHost(
      new PluginServiceRegistry({
        list: async () => ["fixture"],
        ensure: async () => {},
      }),
    );
    const scope = new PluginEntryScope();
    const registration = createExtensionRegistration(
      host,
      "fixture",
      declarations,
      scope,
    );
    return { host, scope, registration };
  }

  it("publishes only complete declaration sets and disposes them", async () => {
    const { host, scope, registration } = fixture();
    registration.provideExtension(declaration.point, declaration.id, {
      handler,
    });
    expect(host.list()).toEqual([]);
    registration.validate();
    scope.commit();
    expect(host.list()).toHaveLength(1);
    await scope.dispose();
    expect(host.list()).toEqual([]);
  });

  it.each(["missing", "undeclared", "duplicate"])(
    "rolls back %s implementations",
    async (kind) => {
      const { host, scope, registration } = fixture();
      if (kind !== "missing") {
        registration.provideExtension(declaration.point, declaration.id, {
          handler,
        });
        registration.provideExtension(
          declaration.point,
          kind === "duplicate" ? declaration.id : "extra",
          { handler },
        );
      }
      registration.validate();
      expect(() => scope.commit()).toThrow(/extension/i);
      await scope.dispose();
      expect(host.list()).toEqual([]);
    },
  );

  it.each([
    [{}, "session"],
    [
      { en: [{ id: "note", content: "EN", position: "system" as const }] },
      "turn",
    ],
  ])(
    "publishes static prompt segments with variants %j as %s",
    async (variants, volatility) => {
      const host = new PluginExtensionHost(
        new PluginServiceRegistry({
          list: async () => ["fixture"],
          ensure: async () => {},
        }),
      );
      const scope = new PluginEntryScope();
      createExtensionRegistration(
        host,
        "fixture",
        [],
        scope,
        undefined,
        [{ id: "note", content: "STATIC", position: "system" }],
        variants,
      ).validate();
      scope.commit();
      const segments = await host
        .createExecution({
          sessionId: "session",
          locale: "zh-CN",
          signal: new AbortController().signal,
          readPluginData: async () => [],
        })
        .run(promptSegmentV1, { turnId: "turn", playerMessage: "" });
      expect(segments.flat()).toEqual([
        expect.objectContaining({
          content: "STATIC",
          audience: "self",
          volatility,
          providerPluginId: "fixture",
        }),
      ]);
      await scope.dispose();
    },
  );

  it("requires known kernel contracts", async () => {
    const { host, scope, registration } = fixture([
      { point: "unknown.point@1", id: "history" },
    ]);
    // Deliberately not a kernel point: the registration must reject it.
    const provideUnknown = registration.provideExtension as (
      point: string,
      id: string,
      definition: { handler: typeof handler },
    ) => void;
    provideUnknown("unknown.point@1", "history", { handler });
    registration.validate();
    expect(() => scope.commit()).toThrow("Invalid extension implementation");
    await scope.dispose();
    expect(host.list()).toEqual([]);
  });
});
