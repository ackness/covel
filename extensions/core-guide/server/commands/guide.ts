import { z } from "zod";

export const command = {
  argsSchema: z.object({
    _: z.array(z.string()).default([]),
    topic: z.string().optional()
  }),
  async execute(args: { _: string[]; topic?: string }) {
    const topic = args.topic ?? args._[0] ?? "current objective";

    return {
      content: `guide package prepared options for ${topic}`,
      blocks: [
        {
          id: "blk_guide",
          type: "choices",
          version: "1.0",
          meta: {
            package: "core-guide",
            requestId: "req_guide",
            traceId: "tr_guide",
            sessionId: "ses_guide",
            turnId: "turn_guide"
          },
          interaction: {
            requiresResponse: true,
            responseSchema: "schemas/blocks/choices.response.json",
            submitAs: "block_response",
            resumePolicy: "resume_current_flow"
          },
          data: {
            title: `Next move for ${topic}`,
            options: [
              { id: "opt_a", label: "Advance" },
              { id: "opt_b", label: "Observe" }
            ]
          }
        }
      ]
    };
  },
  help: {
    usage: "/guide [topic]"
  },
  autocomplete: {
    positionalHints: ["topic"]
  }
};
