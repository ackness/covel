import { makeProposal } from "@covel/plugin-handlers-utils";
import { withPendingProposals } from "@covel/tools";

// Labels are stored as I18nText into plugin_data so the Badge renderer resolves
// them to the session locale (a bare zh string would render Chinese for en
// players). The CI i18n gate doesn't scan tool-written values, so keep these
// bilingual by hand.
const KIND_CONFIG = {
  observe: { label: { zh: "观察", en: "Observe" }, icon: "eye", color: "blue" },
  ask: { label: { zh: "追问", en: "Ask" }, icon: "lightbulb", color: "purple" },
  act: { label: { zh: "行动", en: "Act" }, icon: "zap", color: "green" },
  social: {
    label: { zh: "交涉", en: "Negotiate" },
    icon: "user",
    color: "amber",
  },
};

export default function ({ tool, z }) {
  const promptSchema = z.object({
    kind: z
      .enum(["observe", "ask", "act", "social"])
      .describe("Prompt type: observe/ask/act/social"),
    text: z
      .string()
      .min(1)
      .max(80)
      .describe(
        "A short, scene-specific action phrase the player can send directly",
      ),
  });

  return tool({
    name: "generate-scene-prompts",
    description:
      "Summarize confirmed context and generate scene-specific quick replies. Written to the message namespace; the frontend renders the recap, current decision, and prompt buttons together.",
    parameters: z.object({
      scene: z
        .string()
        .min(1)
        .max(40)
        .describe("Title of the current scene or decision point"),
      recap: z
        .string()
        .trim()
        .min(20)
        .max(240)
        .describe(
          "A 1-3 sentence recap using only confirmed facts and explicit player intentions, commitments, or agreements",
        ),
      decision: z
        .string()
        .trim()
        .min(8)
        .max(120)
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
          label: config.label,
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
