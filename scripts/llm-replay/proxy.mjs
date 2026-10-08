// A record-and-replay proxy in front of an OpenAI-compatible model endpoint,
// built on @copilotkit/aimock (see replay-proxy.mjs). Point a slot's `baseUrl`
// in llm.toml at it.
//
//   pnpm llm:replay --mode record --fixtures debugs/llm-replay/s1 --upstream https://api.example.com
//   pnpm llm:replay --mode replay --fixtures debugs/llm-replay/s1
//
// record: a request that was recorded before is answered from the fixtures;
//         any other goes to the upstream endpoint and its answer is recorded.
//         `--upstream` is the endpoint's origin, without `/v1`.
// replay: no upstream; a request that was not recorded gets an error.
//
// Other options: `--port <n>` (default 4012) and `--tag <name>` (default: the
// mode), which names the statistics file and the folder of keyed requests
// written next to the fixtures.
//
// A streamed answer is recorded with its timing. `--speed <n>` divides the
// recorded delays on replay (default 1000, as fast as the server reads;
// `--speed 1` keeps the recorded pace).
//
// `pnpm e2e:replay` (run.mjs) starts this proxy, a test server and the
// scripted session in one command, for the sessions under tests/llm-replay/.
//
// Docs: docs/guide/e2e-plugin-verify.md
import { writeFileSync } from "node:fs";
import { startReplayProxy } from "./replay-proxy.mjs";

const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const MODE = option("mode");
const UPSTREAM = option("upstream");
if (
  (MODE !== "record" && MODE !== "replay") ||
  (MODE === "record" && !UPSTREAM)
) {
  console.error(
    "usage: proxy.mjs --mode record --upstream <origin> --fixtures <dir>\n       proxy.mjs --mode replay --fixtures <dir>",
  );
  process.exit(2);
}
const FIXTURES = option("fixtures", "debugs/llm-replay/default");
const TAG = option("tag", MODE);
const STATS = `${FIXTURES}.${TAG}.stats.json`;

const proxy = await startReplayProxy({
  mode: MODE,
  fixtures: FIXTURES,
  upstream: UPSTREAM,
  // Every request as it is keyed, for `pnpm llm:replay:diff`.
  requestsDir: `${FIXTURES}.${TAG}.requests`,
  port: Number(option("port", "4012")),
  speed: Number(option("speed", "1000")),
});
console.log(
  `llm-replay ${MODE} on ${proxy.url}, fixtures: ${FIXTURES} (${proxy.fixtureFilesBefore} files), upstream: ${MODE === "record" ? UPSTREAM : "none"}`,
);

// On Ctrl-C or SIGTERM: how many requests the fixtures answered.
const finish = async () => {
  const { mode, ...rest } = await proxy.stop();
  const stats = { mode, tag: TAG, ...rest };
  writeFileSync(STATS, `${JSON.stringify(stats, null, 1)}\n`);
  console.log(JSON.stringify(stats));
  process.exit(0);
};
process.on("SIGTERM", finish);
process.on("SIGINT", finish);
