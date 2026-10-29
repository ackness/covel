import { z } from "zod";

/** Keep plugin actions separate from the gate's internal capability keys. */
export const rpcActionNameSchema = z
  .string()
  .min(1)
  .regex(/^(?!(?:covel|runtime|event):)[\s\S]+$/, {
    message:
      "RPC action names must not start with covel:, runtime: or event: (reserved for framework approvals)",
  })
  .describe(
    "RPC action name. The covel:, runtime: and event: prefixes are reserved for framework approvals.",
  );
