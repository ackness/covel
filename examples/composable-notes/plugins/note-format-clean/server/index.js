import { cleanNote } from "./format.js";

export default function (covel) {
  const { z } = covel.toolkit;
  covel.registerService({
    name: "format-note",
    contract: "examples/note-format@1",
    description:
      "Trim line whitespace and excess blank lines; preserve paragraphs.",
    input: z.object({ text: z.string().max(4000).trim().min(1) }),
    output: z.object({ text: z.string().max(8000).trim().min(1) }),
    handler({ text }, ctx) {
      ctx.signal.throwIfAborted();
      return { text: cleanNote(text) };
    },
  });
}
