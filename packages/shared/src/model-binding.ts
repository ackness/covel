import { z } from "zod";

/** Local model references and server preset IDs are separate namespaces. */
export type LlmModelBinding =
  | { modelRef: string; presetId?: never }
  | { presetId: string; modelRef?: never };

const publicId = z
  .string()
  .min(1)
  .refine((id) => !id.includes("\u0000"));

export const llmModelBindingSchema: z.ZodType<LlmModelBinding> = z.union([
  z.strictObject({ modelRef: z.string().trim().pipe(publicId) }),
  z.strictObject({ presetId: publicId }),
]);
