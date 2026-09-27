import { describe, expect, it } from "vitest";
import { PluginServiceRegistry } from "../src/plugin-services.js";
import { PluginExtensionHost } from "../src/plugin-extensions.js";
import { PluginEntryScope } from "../src/plugin-entry-scope.js";
import { createExtensionRegistration } from "../src/plugin-extension-registration.js";

const declaration = { point: "prompt.history-transform@1", id: "history" };
const handler = async (input: unknown) => input;

describe("extension declaration publication", () => {
  function fixture(declarations = [declaration]) {
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

  it("requires known kernel contracts", async () => {
    const { host, scope, registration } = fixture([
      { point: "unknown.point@1", id: "history" },
    ]);
    registration.provideExtension("unknown.point@1", "history", { handler });
    registration.validate();
    expect(() => scope.commit()).toThrow("Invalid extension implementation");
    await scope.dispose();
    expect(host.list()).toEqual([]);
  });
});
