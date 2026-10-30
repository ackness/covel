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
    expect(validate({ choice: "no" }, structuredClone(schema))).toMatchObject({
      message: expect.stringContaining("allowed values"),
    });
    expect(compile).toHaveBeenCalledTimes(initial);
    validate(1, { type: "number" });
    validate("ok", { type: "string" });
    expect(validate({ choice: "no" }, schema)).toMatchObject({
      message: expect.stringContaining("allowed values"),
    });
    expect(compile).toHaveBeenCalledTimes(initial + 3);
    expect(remove).toHaveBeenCalledWith(schema);
  } finally {
    compile.mockRestore();
    remove.mockRestore();
  }
});

it.each([
  { type: "not-a-json-schema-type" },
  { type: "object", required: "name" },
  { $ref: "https://invalid.example/missing-schema" },
  null,
  false,
  [],
  "object",
])("refuses an invalid resume schema %j", (schema) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    expect(createResumeValidator()({ name: "Ada" }, schema)).toMatchObject({
      code: "resume_schema_invalid",
    });
  } finally {
    warn.mockRestore();
  }
});

it("validates answers compiled from form fields including titles, defaults and bounds", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string", title: "Your name", minLength: 1 },
      age: {
        type: "number",
        title: "Age",
        minimum: 1,
        maximum: 100,
        default: 21,
      },
      agree: { type: "boolean", title: "Agree" },
      route: { type: "string", title: "Route", enum: ["gate", "inn"] },
    },
    required: ["name", "route"],
    additionalProperties: false,
  };
  const validate = createResumeValidator();
  const good = { name: "Alex", age: 21, agree: true, route: "gate" };
  expect(validate(good, schema)).toBeNull();
  for (const answer of [
    { route: "gate" },
    { ...good, age: 101 },
    { ...good, route: "lake" },
  ])
    expect(validate(answer, schema)).toMatchObject({
      code: "resume_data_invalid",
    });
});
