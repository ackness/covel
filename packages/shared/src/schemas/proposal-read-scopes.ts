import { z } from "zod";

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const absent = z.strictObject({ exists: z.literal(false) });
const contentBasis = z.union([
  absent,
  z.strictObject({ exists: z.literal(true), fingerprint }),
]);
const characterBasis = z.union([
  absent,
  z.strictObject({
    exists: z.literal(true),
    fingerprint,
    version: z.number().int().positive(),
  }),
]);

/** Host continuation schema; never part of an authored manifest or tool. */
export const proposalReadPreconditionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("plugin-data"),
    pluginId: z.string().min(1),
    namespace: z.string().min(1),
    key: z.string().min(1),
    basis: contentBasis,
    unstable: z.literal(true).optional(),
  }),
  z.strictObject({
    kind: z.literal("character"),
    id: z.string().min(1),
    basis: characterBasis,
    unstable: z.literal(true).optional(),
  }),
]);

export const proposalReadScopesSchema = z
  .array(
    z.strictObject({
      reads: z.array(proposalReadPreconditionSchema).max(4096),
      proposalIds: z.array(z.string()).max(4096).optional(),
    }),
  )
  .max(4096);
