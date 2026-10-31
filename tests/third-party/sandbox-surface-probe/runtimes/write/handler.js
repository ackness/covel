export default async function (ctx) {
  const ask = ctx.manualPayload?.ask;
  if (ask === "form")
    return {
      outcome: "success",
      value: { privateResult: "bridge-private-result" },
      effects: {
        interactions: [
          {
            type: "form",
            interactionId: "bridge-form",
            title: "Choose a route",
            submitLabel: "Answer route",
            fields: [
              { name: "route", type: "text", label: "Route", required: true },
            ],
            narrativeTemplate: "Route: {{route}}",
          },
        ],
      },
    };
  if (ask === "choice")
    return {
      outcome: "success",
      effects: {
        interactions: [
          {
            type: "choice",
            interactionId: "bridge-choice",
            prompt: "Choose a path",
            choices: [
              { id: "left", label: "Left" },
              { id: "right", label: "Right" },
            ],
          },
        ],
      },
    };
  if (ask === "confirmation")
    return {
      outcome: "success",
      effects: {
        interactions: [
          {
            type: "confirmation",
            interactionId: "bridge-confirmation",
            prompt: "Continue?",
          },
        ],
      },
    };
  const text =
    typeof ctx.manualPayload?.text === "string"
      ? ctx.manualPayload.text
      : "A public note";
  await ctx.pluginData.update("notes", "bridge", [
    { op: "set", value: { id: "bridge", text } },
  ]);
  return {
    outcome: "success",
    value: { saved: true, privateResult: "bridge-private-result" },
  };
}
