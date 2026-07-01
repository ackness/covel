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

function makePluginDataBatchProposal(context, items, timestamp) {
  return {
    id: crypto.randomUUID(),
    type: "plugin.data.batch",
    source: { pluginId: context.pluginId, runtimeId: context.runtimeId },
    turnId: context.turnId,
    sessionId: context.sessionId,
    payload: { items },
    timestamp,
  };
}

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
      "Generate scene-specific quick replies. Written to the message namespace; the frontend renders them via ui.message as prompt buttons the player can edit or send directly.",
    parameters: z.object({
      scene: z
        .string()
        .min(1)
        .max(40)
        .describe("Title of the current scene or decision point"),
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
          prompts,
        },
        [makePluginDataBatchProposal(context, items, now)],
      );
    },
  });
}
