import { z } from "zod";
import { tool } from "@covel/plugin-handlers-utils";
import { delegateParametersSchema, delegateTool } from "./delegate.js";

export const DELEGATE_BATCH_TOOL_NAME = "delegate-batch";
export const DELEGATE_BATCH_MAX_REQUESTS = 32;

/** Validate the container separately so an invalid child cannot hide siblings. */
export const delegateBatchEnvelopeSchema = z.strictObject({
  requests: z.array(z.unknown()).min(1).max(DELEGATE_BATCH_MAX_REQUESTS),
});

export const delegateBatchParametersSchema = z.strictObject({
  requests: z
    .array(delegateParametersSchema)
    .min(1)
    .max(DELEGATE_BATCH_MAX_REQUESTS),
});

export const delegateBatchTool = tool({
  name: DELEGATE_BATCH_TOOL_NAME,
  description:
    "Run a bounded batch of independent sub-agent requests concurrently. Requests and results stay in input order. Each result is {ok:true,output} or {ok:false,error:{code,message}} inside results. Existing shared depth, actor, call and concurrent limits apply; excess requests are refused immediately, never queued or retried. Siblings receive independent briefs and snapshots, never one another's replies. Allowed write-service changes remain staged until turn end and may still be rejected.",
  annotations: delegateTool.annotations,
  parameters: delegateBatchParametersSchema,
  execute: async () => {
    throw new Error("delegate-batch runs only inside an agent loop");
  },
});
