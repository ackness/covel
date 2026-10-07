import { expect, it, vi } from "vitest";
import { Ajv } from "ajv";
import { createResumeValidator } from "../../src/lib/resume-schema.js";

it("reuses cloned schemas and evicts old validators without retaining Ajv schemas", () => {
  const compile = vi.spyOn(Ajv.prototype, "compile");
  const remove = vi.spyOn(Ajv.prototype, "removeSchema");
  try {
    const validate = createResumeValidator(2);
    const schema = {
      type: "object",
      required: ["choice"],
      properties: { choice: { enum: ["yes"] } },
    };
    expect(validate({ choice: "yes" }, schema)).toBeNull();
    const initial = compile.mock.calls.length;
    expect(validate({ choice: "no" }, structuredClone(schema))).toContain(
      "allowed values",
    );
    expect(compile).toHaveBeenCalledTimes(initial);
    validate(1, { type: "number" });
    validate("ok", { type: "string" });
    expect(validate({ choice: "no" }, schema)).toContain("allowed values");
    expect(compile).toHaveBeenCalledTimes(initial + 3);
    expect(remove).toHaveBeenCalledWith(schema);
  } finally {
    compile.mockRestore();
    remove.mockRestore();
  }
});
