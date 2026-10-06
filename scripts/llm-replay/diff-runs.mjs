// Two runs of one scripted session through `pnpm llm:replay`: which requests
// of the second run were not in the first, and where each starts to differ
// from the nearest request of the first run.
//
//   pnpm llm:replay:diff debugs/llm-replay/s1.run1.requests debugs/llm-replay/s1.run2.requests
//
// SHOW=<n> prints the first n unmatched requests (default 6).
import { readdirSync, readFileSync } from "node:fs";

const [first, second] = process.argv.slice(2);
if (!first || !second) {
  console.error("usage: diff-runs.mjs <first.requests> <second.requests>");
  process.exit(2);
}
const load = (dir) =>
  new Map(
    readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => [
        name,
        JSON.parse(readFileSync(`${dir}/${name}`, "utf8")),
      ]),
  );
const a = load(first);
const b = load(second);
const flat = (request) =>
  (request.messages ?? [])
    .map(
      (message) =>
        (typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content ?? "")) +
        JSON.stringify(message.tool_calls ?? ""),
    )
    .join("\n");
const systemOf = (request) => {
  const message = (request.messages ?? []).find((m) => m.role === "system");
  return typeof message?.content === "string"
    ? message.content.slice(0, 400)
    : "";
};
const commonPrefix = (x, y) => {
  let index = 0;
  const end = Math.min(x.length, y.length);
  while (index < end && x[index] === y[index]) index += 1;
  return index;
};

const missed = [...b]
  .filter(([name]) => !a.has(name))
  .sort((x, y) => x[1].order - y[1].order);
console.log(
  `first run: ${a.size} distinct requests; second run: ${b.size}; in the second and not in the first: ${missed.length}`,
);

// The nearest request of the first run: the same start of the system prompt,
// then the longest common prefix.
for (const [name, request] of missed.slice(0, Number(process.env.SHOW ?? 6))) {
  const mine = flat(request);
  let best;
  let bestLength = -1;
  for (const [, other] of a) {
    if (systemOf(other) !== systemOf(request)) continue;
    const length = commonPrefix(flat(other), mine);
    if (length > bestLength) {
      bestLength = length;
      best = other;
    }
  }
  const title = systemOf(request).replace(/\s+/g, " ").slice(0, 70);
  if (!best) {
    console.log(
      `\n#${request.order} ${name}: no request with this system prompt in the first run — ${title}`,
    );
    continue;
  }
  const theirs = flat(best);
  const at = bestLength;
  console.log(`\n#${request.order} ${name} (${mine.length} chars) — ${title}`);
  console.log(
    `  same as #${best.order} of the first run for ${at} chars, then:`,
  );
  console.log(
    `  first : …${JSON.stringify(theirs.slice(Math.max(0, at - 60), at + 140))}`,
  );
  console.log(
    `  second: …${JSON.stringify(mine.slice(Math.max(0, at - 60), at + 140))}`,
  );
  const otherFields = Object.keys(request).filter(
    (key) =>
      !["messages", "order"].includes(key) &&
      JSON.stringify(request[key]) !== JSON.stringify(best[key]),
  );
  if (otherFields.length)
    console.log(`  other fields that differ: ${otherFields.join(", ")}`);
}
