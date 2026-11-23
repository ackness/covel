import { z } from "zod";
import { kernelExtensionPoints } from "../extension-points/contracts.js";
import { defineExtensionPoint } from "../extension-points/definition.js";

export const channelBridgeInputSchema = z.discriminatedUnion("phase", [
  z.strictObject({
    phase: z.literal("inboundMessage"),
    channelId: z.string().min(1).max(64),
    externalUserId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    text: z.string().max(16_000),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.strictObject({
    phase: z.literal("beforeRender"),
    channelId: z.string().min(1).max(64),
    sessionId: z.string().min(1).max(128),
    turnId: z.string().min(1).max(128),
    story: z.string().max(64_000),
    choices: z
      .array(
        z.strictObject({
          id: z.string().min(1),
          text: z.string(),
        }),
      )
      .max(32)
      .optional(),
  }),
  z.strictObject({
    phase: z.literal("outboundEvent"),
    channelId: z.string().min(1).max(64),
    sessionId: z.string().min(1).max(128),
    turnId: z.string().min(1).max(128).optional(),
    topic: z.string().min(1).max(128),
    payload: z.record(z.string(), z.unknown()),
  }),
]);

export type ChannelBridgeInput = z.infer<typeof channelBridgeInputSchema>;

export const channelBridgeOutputSchema = z.strictObject({
  handled: z.boolean(),
  formattedText: z.string().max(64_000).optional(),
  routedSessionId: z.string().min(1).max(128).optional(),
  rejectedReason: z.string().max(512).optional(),
  providerPluginId: z.string().optional(),
});

export type ChannelBridgeOutput = z.infer<typeof channelBridgeOutputSchema>;

export const channelBridgeV1 = defineExtensionPoint({
  ...kernelExtensionPoints.channelBridge,
  scope: "instance",
  input: channelBridgeInputSchema,
  output: channelBridgeOutputSchema,
  timeoutMs: 5_000,
  onError: "skip",
  attributeOutput: (output: ChannelBridgeOutput, provider) => ({
    ...output,
    providerPluginId: provider.pluginId,
  }),
});
