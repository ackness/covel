import { describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import {
  ToolValidationError,
  type FormField,
} from "@covel/plugin-handlers-utils";
import {
  suspendTool,
  isSuspendSentinel,
  suspendFieldsToResumeSchema,
  type SuspendSentinel,
} from "../src/index.js";

const context = {
  sessionId: "session",
  turnId: "turn",
  pluginId: "probe",
  runtimeId: "probe/ask",
  random: { int: (min: number) => min },
};
const fields: FormField[] = [
  {
    type: "text",
    name: "name",
    label: "Name",
    required: true,
    defaultValue: "Alex",
  },
  { type: "textarea", name: "notes", label: "Notes" },
  {
    type: "number",
    name: "age",
    label: "Age",
    min: 1,
    max: 100,
    step: 2,
    required: true,
    defaultValue: 21,
  },
  { type: "checkbox", name: "agree", label: "Agree", defaultValue: false },
  {
    type: "select",
    name: "route",
    label: "Route",
    options: ["gate", { value: "inn", label: "The Inn" }],
    defaultValue: "inn",
    required: true,
  },
];
const schema = {
  type: "object",
  properties: {
    name: { type: "string", title: "Name", minLength: 1, default: "Alex" },
    notes: { type: "string", title: "Notes" },
    age: {
      type: "number",
      title: "Age",
      minimum: 1,
      maximum: 100,
      default: 21,
    },
    agree: { type: "boolean", title: "Agree", default: false },
    route: {
      type: "string",
      title: "Route",
      enum: ["gate", "inn"],
      default: "inn",
    },
  },
  required: ["name", "age", "route"],
  additionalProperties: false,
};

describe("suspend forms", () => {
  it("maps every field type to the stored answer schema", () => {
    expect(suspendFieldsToResumeSchema(fields)).toEqual(schema);
    expect(
      suspendFieldsToResumeSchema([
        { type: "textarea", name: "why", label: "Why", required: true },
      ]),
    ).toMatchObject({ properties: { why: { minLength: 1 } } });
    expect(
      suspendFieldsToResumeSchema([
        { type: "text", name: "optional", label: "Optional" },
      ]),
    ).not.toHaveProperty("required");
  });
  it("returns the unchanged sentinel shape with a compiled schema", async () => {
    expect(suspendTool.name).toBe("suspend");
    const result = await suspendTool.execute(
      { reason: "Need input", fields },
      context,
    );
    expect(result).toEqual({
      _covelSuspend: true,
      reason: "Need input",
      resumeSchema: schema,
    });
    expect(isSuspendSentinel(result)).toBe(true);
  });
  it.each(
    [
      [],
      [
        { type: "text", name: "same", label: "One" },
        { type: "number", name: "same", label: "Two" },
      ],
      [{ type: "text", name: "", label: "Empty" }],
      [{ type: "text", name: " ", label: "Blank" }],
      [{ type: "select", name: "route", label: "Route" }],
      [{ type: "select", name: "route", label: "Route", options: [] }],
      [
        {
          type: "select",
          name: "route",
          label: "Route",
          options: ["gate"],
          defaultValue: "inn",
        },
      ],
    ].map((fields) => ({ fields })),
  )(
    "rejects an invalid field list: $fields",
    async ({ fields: invalidFields }) => {
      const error = await suspendTool
        .execute({ reason: "Need input", fields: invalidFields }, context)
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ToolValidationError);
      expect(error).toMatchObject({ code: "invalid-input" });
    },
  );
  it("requires fields instead of a raw schema argument", async () => {
    await expect(
      suspendTool.execute({ reason: "Need input", resumeSchema: {} }, context),
    ).rejects.toMatchObject({
      code: "invalid-input",
      details: expect.arrayContaining([
        expect.objectContaining({ path: "fields" }),
      ]),
    });
  });
  it("validates form answers with the resume validator's JSON Schema settings", () => {
    const validate = new Ajv({ strict: false }).compile(
      suspendFieldsToResumeSchema(fields),
    );
    const good = { name: "Alex", age: 21, agree: true, route: "gate" };
    expect(validate(good)).toBe(true);
    expect(validate({ age: 21, route: "gate" })).toBe(false);
    expect(validate({ ...good, age: 101 })).toBe(false);
    expect(validate({ ...good, route: "lake" })).toBe(false);
    expect(validate({ ...good, name: "" })).toBe(false);
    expect(validate({ ...good, extra: true })).toBe(false);
  });
});

describe("isSuspendSentinel", () => {
  it("returns true for a valid sentinel", () => {
    const sentinel: SuspendSentinel = {
      _covelSuspend: true,
      reason: "test",
      resumeSchema: { type: "object" },
    };
    expect(isSuspendSentinel(sentinel)).toBe(true);
  });

  it("returns false for a regular object", () => {
    expect(isSuspendSentinel({ foo: "bar" })).toBe(false);
  });

  it("returns false for null", () => {
    expect(isSuspendSentinel(null)).toBe(false);
  });

  it("returns false for string", () => {
    expect(isSuspendSentinel("suspend")).toBe(false);
  });

  it("returns false when _covelSuspend is not true", () => {
    expect(
      isSuspendSentinel({
        _covelSuspend: false,
        reason: "x",
        resumeSchema: {},
      }),
    ).toBe(false);
  });

  it("returns false when reason is missing", () => {
    expect(isSuspendSentinel({ _covelSuspend: true, resumeSchema: {} })).toBe(
      false,
    );
  });

  it("returns false when reason is not a string", () => {
    expect(
      isSuspendSentinel({ _covelSuspend: true, reason: 42, resumeSchema: {} }),
    ).toBe(false);
  });
});
