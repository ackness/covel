import { expect } from "vitest";
import type { ZodType } from "zod";

export function expectSchemaAccepts(
  schema: ZodType,
  input: unknown,
): void {
  const result = schema.safeParse(input);

  expect(result.success).toBe(true);
}

export function expectSchemaRejects(
  schema: ZodType,
  input: unknown,
): void {
  const result = schema.safeParse(input);

  expect(result.success).toBe(false);
}
