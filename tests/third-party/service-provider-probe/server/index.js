export default function (covel) {
  const { z } = covel.toolkit;
  covel.registerService({
    name: "format-note",
    contract: "probe/note-format@1",
    input: z.object({ text: z.string().min(1).max(200) }),
    output: z.object({ text: z.string() }),
    handler({ text }, ctx) {
      ctx.signal.throwIfAborted();
      return { text: `[formatted] ${text}` };
    },
  });
}
