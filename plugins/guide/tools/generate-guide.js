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

/**
 * A reply written as plain text is its `text`. The model sometimes writes
 * the replies as a list of sentences; each one says what the player would
 * send, which is all a reply needs. It shows without a tag.
 */
function normalizeArguments(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    !Array.isArray(input.prompts)
  )
    return input;
  return {
    ...input,
    prompts: input.prompts.map((prompt) =>
      typeof prompt === "string" ? { text: prompt } : prompt,
    ),
  };
}

export default function ({ tool, z }) {
  // `text` comes first: the model writes the action, then labels it. With
  // `kind` first it picked one of each type and wrote a phrase to fit.
  const promptSchema = z.object({
    text: z
      .string()
      .min(1)
      .max(MAX_PROMPT)
      .describe(
        "One answer to the decision: a short action phrase the player can send as written",
      ),
    kind: z
      .enum(["observe", "ask", "act", "social"])
      .optional()
      .describe(
        "Display tag: the type nearest to the text. Types can repeat: observe/ask/act/social",
      ),
  });

  return tool({
    name: "generate-guide",
    description:
      "Summarize confirmed context and generate scene-specific quick replies. Written to the message namespace; the frontend renders the recap, current decision, and prompt buttons together.",
    parameters: z.preprocess(
      normalizeArguments,
      z.object({
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
            "A 1-3 sentence recap of confirmed facts and stated player intentions, ending at the state where this turn's narrative ends",
          ),
        decision: z
          .string()
          .trim()
          .min(8)
          .max(MAX_DECISION)
          .describe(
            "The one question that the end of this turn's narrative puts to the player",
          ),
        // The prompt body asks for 3-4. Six is the bound, like the lengths
        // above: an entry over the target is not worth a rejected call.
        prompts: z
          .array(promptSchema)
          .min(3)
          .max(6)
          .describe(
            "3-4 different answers to the decision. Do not offer what the narrative already completed or answered",
          ),
      }),
    ),
    execute: async (params, context) => {
      const now = new Date().toISOString();
      const prompts = params.prompts.slice(0, 6).map((prompt) => {
        // A reply without a kind shows without a tag.
        if (!prompt.kind) return { text: prompt.text };
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
