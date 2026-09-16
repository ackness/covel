export default async function (ctx) {
  return {
    outcome: "success",
    value: {
      narrativeOutput: `A sealed door awaits. Player action: ${ctx.playerMessage}`,
    },
  };
}
