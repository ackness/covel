export const tool = {
  id: "roll-luck",
  description: "Roll a 1-100 luck value and return the structured tier result.",
  exported: true,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      modifier: {
        type: "integer",
        description: "Luck modifier read from game state."
      },
      weight: {
        type: "number",
        description: "Multiplier from runtime settings."
      }
    },
    required: ["modifier", "weight"]
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      roll: {
        type: "integer",
        minimum: 1,
        maximum: 100
      },
      modifier: {
        type: "integer"
      },
      weightedRoll: {
        type: "integer",
        minimum: 1,
        maximum: 100
      },
      tier: {
        type: "string",
        enum: ["common", "rare", "epic"]
      }
    },
    required: ["roll", "modifier", "weightedRoll", "tier"]
  },
  async execute(ctx) {
    const modifier = ctx.input?.modifier ?? 0;
    const weight = ctx.input?.weight ?? 1;
    const roll = Math.floor(Math.random() * 100) + 1;
    const weightedRoll = Math.max(1, Math.min(100, Math.round(roll + modifier * weight)));

    let tier = "common";
    if (weightedRoll >= 90) {
      tier = "epic";
    } else if (weightedRoll >= 60) {
      tier = "rare";
    }

    return {
      roll,
      modifier,
      weightedRoll,
      tier
    };
  }
};
