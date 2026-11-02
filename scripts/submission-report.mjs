// Read-only summary of local harness artifacts. No provider calls or raw text output.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { submissionReport } from "./lib/submission-report.mjs";

try {
  const { values } = parseArgs({
    options: {
      traces: { type: "string" },
      turns: { type: "string" },
      sample: { type: "string" },
      lane: { type: "string" },
      help: { type: "boolean" },
    },
  });
  const help =
    "node scripts/submission-report.mjs --traces <traces.json> --turns <turns.json> --sample natural|injected --lane official-deepseek|relay-deepseek|relay-luna|official-openai";
  if (values.help) console.log(help);
  else {
    if (
      !values.traces ||
      !values.turns ||
      ![
        "official-deepseek",
        "relay-deepseek",
        "relay-luna",
        "official-openai",
      ].includes(values.lane)
    )
      throw new Error("Invalid report arguments");
    const trace = JSON.parse(readFileSync(values.traces, "utf8"));
    const turns = JSON.parse(readFileSync(values.turns, "utf8"));
    console.log(
      JSON.stringify(
        {
          lane: values.lane,
          ...submissionReport({
            events: trace.events,
            turns,
            sample: values.sample,
          }),
        },
        null,
        2,
      ),
    );
  }
} catch {
  // File/parse errors may contain private paths or model text. Print a fixed error.
  console.error(
    "Submission report failed: check --help, input JSON and current trace identities.",
  );
  process.exitCode = 2;
}
