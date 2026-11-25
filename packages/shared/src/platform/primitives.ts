import { z } from "zod";

export const PLATFORM_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * Shared non-empty alphanumeric ID schema (`a-z0-9._-`, max 64 chars) that also
 * rejects reserved `covel:` and `runtime:` prefixes.
 */
export function createPlatformIdSchema(label: string) {
  return z
    .string()
    .regex(PLATFORM_ID_RE, {
      message: `${label} must start with an alphanumeric character and use only letters, digits, \`.\`, \`_\`, or \`-\` (max 64 chars)`,
    })
    .refine(
      (id) =>
        !id.toLowerCase().startsWith("covel:") &&
        !id.toLowerCase().startsWith("runtime:"),
      {
        message: `${label} cannot use reserved covel: or runtime: prefixes`,
      },
    );
}

export const platformTextSchema = z.union([
  z.string().min(1),
  z.record(z.string().min(1), z.string()),
]);

export type PlatformText = z.infer<typeof platformTextSchema>;
