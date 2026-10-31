/**
 * An entry registers exactly what its manifest declares. A service offered
 * to models is declared as one, so the two can never disagree.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PluginManifest } from "@covel/shared";
import { enforcePluginRegistrationContract } from "../src/plugin-registration-contract.js";
import type { PluginAPI } from "../src/plugin-api.js";

type Contributions = NonNullable<PluginManifest["contributes"]>;

const service = {
  name: "items",
  contract: "inventory.items@1",
  description: "List the items in a bag",
  input: z.object({ bag: z.string() }),
  output: z.unknown(),
  handler: () => [],
};

function register(
  declared: Contributions,
  modelFacing: boolean | undefined,
  access?: "read" | "write",
) {
  const registerService = vi.fn();
  const contract = enforcePluginRegistrationContract(
    { registerService } as unknown as PluginAPI,
    declared,
  );
  contract.api.registerService({
    ...service,
    ...(modelFacing !== undefined ? { modelFacing } : {}),
    ...(access !== undefined ? { access } : {}),
  } as never);
  contract.validate();
  return registerService;
}

describe("the service registration contract", () => {
  it("rejects a model-facing registration declared as a plain service", () => {
    expect(() => register({ services: ["inventory.items@1"] }, true)).toThrow(
      "Undeclared or duplicate registration: service:inventory.items@1 (model-facing)",
    );
  });

  it("rejects a plain registration declared as model-facing", () => {
    expect(() =>
      register(
        { services: [{ contract: "inventory.items@1", modelFacing: true }] },
        false,
      ),
    ).toThrow(
      "Undeclared or duplicate registration: service:inventory.items@1",
    );
  });

  it("publishes when both say the same", () => {
    expect(
      register(
        { services: [{ contract: "inventory.items@1", modelFacing: true }] },
        true,
      ),
    ).toHaveBeenCalledOnce();
    // `{ contract }` and the string form mean the same.
    expect(
      register({ services: [{ contract: "inventory.items@1" }] }, undefined),
    ).toHaveBeenCalledOnce();
    expect(
      register({ services: ["inventory.items@1"] }, false),
    ).toHaveBeenCalledOnce();
  });

  it("rejects a write registration declared as a read service", () => {
    expect(() =>
      register({ services: ["inventory.items@1"] }, undefined, "write"),
    ).toThrow(
      "Undeclared or duplicate registration: service:inventory.items@1 (write)",
    );
  });

  it("rejects a read registration declared as a write service", () => {
    expect(() =>
      register(
        { services: [{ contract: "inventory.items@1", access: "write" }] },
        undefined,
        "read",
      ),
    ).toThrow(
      "Undeclared or duplicate registration: service:inventory.items@1",
    );
  });

  it("publishes a write service that both declare, model-facing or not", () => {
    expect(
      register(
        { services: [{ contract: "inventory.items@1", access: "write" }] },
        undefined,
        "write",
      ),
    ).toHaveBeenCalledOnce();
    expect(
      register(
        {
          services: [
            {
              contract: "inventory.items@1",
              access: "write",
              modelFacing: true,
            },
          ],
        },
        true,
        "write",
      ),
    ).toHaveBeenCalledOnce();
    // `access: read` and no access mean the same.
    expect(
      register(
        { services: [{ contract: "inventory.items@1", access: "read" }] },
        undefined,
        undefined,
      ),
    ).toHaveBeenCalledOnce();
  });
});
