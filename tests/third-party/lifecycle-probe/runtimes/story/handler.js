export default async function (ctx) {
  return {
    outcome: "success",
    value: {
      segments: [
        { kind: "narration", text: "A sealed door awaits." },
        { kind: "narration", text: `Player action: ${ctx.playerMessage}` },
      ],
    },
  };
}
