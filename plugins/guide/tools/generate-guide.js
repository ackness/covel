import {
  labelText,
  makeProposal,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";

const KIND_CONFIG = {
  observe: { icon: "eye", color: "blue" },
  ask: { icon: "lightbulb", color: "purple" },
  act: { icon: "zap", color: "green" },
  social: { icon: "user", color: "amber" },
};

/**
 * The kind's name in every language the plugin ships. Only the Badge of the
 * guide block draws it; it picks the player's UI language.
 */
function kindLabel(context, kind) {
  // Each text is a literal: the validator reads them from the source.
  const labels = {
    observe: labelText(context, "Observe"),
    ask: labelText(context, "Ask"),
    act: labelText(context, "Act"),
    social: labelText(context, "Negotiate"),
  };
  return labels[kind];
}

// These are hard bounds against runaway text, in characters, for every
// language. The same sentence takes two to three times as many characters in
// English as in Chinese, so bounds sized for Chinese rejected most English
// calls. The length to aim for is language-specific and is stated in the
// prompt body.
const MAX_SCENE = 80;
const MAX_RECAP = 600;
const MAX_DECISION = 300;
const MAX_PROMPT = 160;

export default function ({ tool, z }) {
  const promptSchema = z.object({
    kind: z
      .enum(["observe", "ask", "act", "social"])
      .describe("Prompt type: observe/ask/act/social"),
    text: z
      .string()
      .min(1)
      .max(MAX_PROMPT)
      .describe(
        "A short, scene-specific action phrase the player can send directly",
      ),
  });

  return tool({
    name: "generate-guide",
    description:
      "Summarize confirmed context and generate scene-specific quick replies. Written to the message namespace; the frontend renders the recap, current decision, and prompt buttons together.",
    parameters: z.object({
      scene: z
        .string()
        .min(1)
        .max(MAX_SCENE)
        .describe("Title of the current scene or decision point"),
      recap: z
        .string()
        .trim()
        .min(20)
        .max(MAX_RECAP)
        .describe(
          "A 1-3 sentence recap using only confirmed facts and explicit player intentions, commitments, or agreements",
        ),
      decision: z
        .string()
        .trim()
        .min(8)
        .max(MAX_DECISION)
        .describe(
          "The current question or decision the player needs to answer",
        ),
      prompts: z
        .array(promptSchema)
        .min(3)
        .max(6)
        .describe("3-6 short player action phrases that can be sent directly"),
    }),
    execute: async (params, context) => {
      const now = new Date().toISOString();
      const prompts = params.prompts.slice(0, 6).map((prompt) => {
        const config = KIND_CONFIG[prompt.kind];
        return {
          kind: prompt.kind,
          label: kindLabel(context, prompt.kind),
          icon: config.icon,
          color: config.color,
          text: prompt.text,
        };
      });

      const items = [
        { namespace: "message", key: "__turnId", value: context.turnId },
        { namespace: "message", key: "scene", value: params.scene },
        { namespace: "message", key: "recap", value: params.recap },
        { namespace: "message", key: "decision", value: params.decision },
      ];

      for (let i = 0; i < 6; i += 1) {
        const slot = i + 1;
        const prompt = prompts[i];
        items.push(
          {
            namespace: "message",
            key: `prompt${slot}Text`,
            value: prompt?.text ?? "",
          },
          {
            namespace: "message",
            key: `prompt${slot}Label`,
            value: prompt?.label ?? "",
          },
          {
            namespace: "message",
            key: `prompt${slot}Icon`,
            value: prompt?.icon ?? "",
          },
          {
            namespace: "message",
            key: `prompt${slot}Color`,
            value: prompt?.color ?? "",
          },
        );
      }

      return withPendingProposals(
        {
          scene: params.scene,
          recap: params.recap,
          decision: params.decision,
          prompts,
        },
        [makeProposal(context, now, "plugin.data.batch", { items })],
      );
    },
  });
}
