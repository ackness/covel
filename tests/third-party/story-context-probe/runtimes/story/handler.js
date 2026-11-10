export default async function (ctx) {
  const notes = ctx.inputs.context.value.items;
  return {
    outcome: "success",
    value: {
      segments: [
        { kind: "narration", text: `Player action: ${ctx.playerMessage}` },
        ...notes.map((note) => ({
          kind: "narration",
          text: `${note.title}: ${note.content}`,
        })),
      ],
    },
  };
}
