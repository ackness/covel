import { makeProposal } from "@covel/plugin-handlers-utils";
import { withEmittedEvents, withPendingProposals } from "@covel/tools";

const EVENT_TOPIC = "openai-image.generate.requested";

export default function ({ tool, z, shortId }) {
  const composition = z
    .enum(["single-scene", "comic-strip"])
    .describe(
      "The active composition setting; copy it exactly from the prompt.",
    );

  function submitPrompt(prompt, promptMode, selectedComposition, context) {
    const normalizedPrompt =
      typeof prompt === "string" ? prompt.trim() : JSON.stringify(prompt);
    if (normalizedPrompt.length === 0 || normalizedPrompt === "{}") {
      throw new Error("prompt must contain a non-empty image description");
    }

    const output = {
      prompt: normalizedPrompt,
      promptMode,
      composition: selectedComposition,
    };
    const promptKey = shortId(
      "prompt",
      normalizedPrompt.slice(0, 96),
      context.sessionId,
    );
    const now = new Date().toISOString();

    return withPendingProposals(
      withEmittedEvents(output, [
        {
          topic: EVENT_TOPIC,
          data: output,
        },
      ]),
      [
        makeProposal(context, now, "plugin.data", {
          namespace: "prompts",
          key: promptKey,
          value: { ...output, createdAt: now },
        }),
      ],
    );
  }

  return [
    tool({
      name: "submit-openai-image-text-prompt",
      description:
        "Submit one finished natural-language image prompt. This stores the prompt and starts OpenAI-compatible image generation; call it exactly once for promptMode=text.",
      parameters: z.object({
        prompt: z.string().trim().min(1).describe("The complete image prompt."),
        composition,
      }),
      execute: async ({ prompt, composition: selectedComposition }, context) =>
        submitPrompt(prompt, "text", selectedComposition, context),
    }),
    tool({
      name: "submit-openai-image-structured-prompt",
      description:
        "Submit one finished structured image prompt as a JSON object. This stores and serializes it, then starts OpenAI-compatible image generation; call it exactly once for promptMode=image-json.",
      parameters: z.object({
        prompt: z
          .record(z.string(), z.unknown())
          .refine((value) => Object.keys(value).length > 0, {
            message: "prompt must contain at least one field",
          })
          .describe("The complete structured image prompt as an object."),
        composition,
      }),
      execute: async ({ prompt, composition: selectedComposition }, context) =>
        submitPrompt(prompt, "image-json", selectedComposition, context),
    }),
  ];
}
