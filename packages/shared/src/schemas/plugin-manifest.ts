import {
  isKernelExtensionContract,
  INVALID_KERNEL_CONFLICT,
  kernelConflictMessage,
} from "../extension-points/contracts.js";
import { z } from "zod";
import { hostVersionRangeSchema } from "../utils/host-version-range.js";
import {
  contractIdSchema,
  runtimeAuthoringManifestSchema,
} from "./runtime-manifest.js";
import {
  runtimeManifestInputSchema,
  extensionDeclarationSchema,
  hookDeclarationSchema,
  pluginDataSchemaDeclSchema,
  worldProjectionMapSchema,
} from "./plugin-schemas.js";
const shape = runtimeManifestInputSchema.shape;
export const pluginManifestSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  kind: z.enum(["core", "plugin"]),
  version: z.string().optional(),
  // Host versions this package was written for; the installer enforces it.
  covel: hostVersionRangeSchema.optional(),
  displayName: shape.displayName,
  description: shape.description,
  tags: z
    .array(
      z
        .string()
        .refine(
          (tag) => !tag.startsWith("role:"),
          "role tags are replaced by contracts",
        ),
    )
    .optional(),
  provides: z
    .array(
      z.union([
        contractIdSchema,
        z.strictObject({
          contract: contractIdSchema,
          default: z.boolean().optional(),
        }),
      ]),
    )
    .optional(),
  requires: z.array(contractIdSchema).optional(),
  optional: z.array(contractIdSchema).optional(),
  conflicts: z
    .array(
      contractIdSchema.superRefine((contract, ctx) => {
        if (isKernelExtensionContract(contract))
          ctx.addIssue({
            code: "custom",
            message: kernelConflictMessage(contract),
            params: { code: INVALID_KERNEL_CONFLICT },
          });
      }),
    )
    .optional(),
  contracts: z
    .record(contractIdSchema, z.strictObject({ schema: z.string().min(1) }))
    .optional(),
  entry: shape.entry,
  contributes: z
    .strictObject({
      tools: z.array(z.string().min(1)).optional(),
      actions: z.array(z.string().min(1)).optional(),
      commands: shape.commands,
      services: z.array(contractIdSchema).optional(),
      extensions: z.array(extensionDeclarationSchema).optional(),
      hooks: z
        .array(hookDeclarationSchema.pick({ event: true, enforce: true }))
        .optional(),
      wires: z.array(z.string().min(1)).optional(),
      forms: z.array(z.string().min(1)).optional(),
      events: shape.events,
      settings: shape.userSettings,
      data: z
        .record(
          z.string(),
          pluginDataSchemaDeclSchema
            .omit({
              namespace: true,
              schemaVersion: true,
              acceptsWorldData: true,
            })
            .extend({
              version: z.number().int().positive(),
              accepts: z.array(contractIdSchema).optional(),
            }),
        )
        .optional(),
      ui: shape.ui,
      worldProjections: worldProjectionMapSchema.optional(),
      prompt: z
        .array(
          z.strictObject({
            id: z.string().min(1),
            content: z.string(),
            position: z.union([
              z.enum(["system", "pre-history", "post-history"]),
              z.strictObject({ depth: z.number().int().min(0) }),
            ]),
            role: z.enum(["system", "user", "assistant"]).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  runtime: runtimeAuthoringManifestSchema.optional(),
});
