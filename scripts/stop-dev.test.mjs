import assert from "node:assert/strict";
import test from "node:test";

import {
  collectCandidatePids,
  matchesDevCommand,
  parsePidList,
  parseProcessTable,
  selectRootPids,
} from "./stop-dev.mjs";

test("parseProcessTable reads pid, ppid, and command columns", () => {
  const stdout = `
    100 1 node /bin/pnpm dev
    101 100 node ./scripts/dev-supervisor.mjs turbo dev
  `;

  assert.deepEqual(parseProcessTable(stdout), [
    { pid: 100, ppid: 1, command: "node /bin/pnpm dev" },
    { pid: 101, ppid: 100, command: "node ./scripts/dev-supervisor.mjs turbo dev" },
  ]);
});

test("parsePidList de-duplicates pids and ignores invalid rows", () => {
  const stdout = `
    200
    abc
    201
    200
  `;

  assert.deepEqual(parsePidList(stdout), new Set([200, 201]));
});

test("matchesDevCommand detects the covel frontend and backend dev chain", () => {
  assert.equal(matchesDevCommand("node ./scripts/dev-supervisor.mjs turbo dev"), true);
  assert.equal(matchesDevCommand("node /tmp/pnpm dev:web"), true);
  assert.equal(matchesDevCommand("node /tmp/pnpm run dev"), true);
  assert.equal(matchesDevCommand("node /repo/apps/server/node_modules/.bin/../tsx/dist/cli.mjs watch src/index.ts"), true);
  assert.equal(matchesDevCommand("node /repo/apps/web/node_modules/.bin/../vite/bin/vite.js"), true);
  assert.equal(matchesDevCommand("node /tmp/pnpm test:watch"), false);
  assert.equal(matchesDevCommand("node /repo/apps/web/node_modules/.bin/../vite/bin/vite.js preview"), false);
});

test("collectCandidatePids only keeps repo-related frontend and backend dev processes", () => {
  const processes = [
    { pid: 10, ppid: 1, command: "-zsh" },
    { pid: 11, ppid: 10, command: "node /bin/pnpm dev" },
    { pid: 12, ppid: 11, command: "node ./scripts/dev-supervisor.mjs turbo dev" },
    { pid: 13, ppid: 12, command: "node /repo/apps/web/node_modules/.bin/../vite/bin/vite.js" },
    { pid: 14, ppid: 12, command: "node /repo/apps/server/node_modules/.bin/../tsx/dist/cli.mjs watch src/index.ts" },
    { pid: 15, ppid: 10, command: "node /bin/pnpm test:watch" },
    { pid: 20, ppid: 1, command: "node /other-repo/apps/web/node_modules/.bin/../vite/bin/vite.js" },
  ];

  const repoPids = new Set([11, 12, 13, 14, 15]);
  const listeningPids = new Set([13, 14, 20]);

  assert.deepEqual(collectCandidatePids(processes, repoPids, listeningPids, "/repo"), new Set([11, 12, 13, 14]));
});

test("selectRootPids returns topmost matched processes and skips interactive shells", () => {
  const processes = [
    { pid: 10, ppid: 1, command: "-zsh" },
    { pid: 11, ppid: 10, command: "node /bin/pnpm dev" },
    { pid: 12, ppid: 11, command: "node ./scripts/dev-supervisor.mjs turbo dev" },
    { pid: 13, ppid: 12, command: "node /repo/apps/web/node_modules/.bin/../vite/bin/vite.js" },
    { pid: 14, ppid: 12, command: "node /repo/apps/server/node_modules/.bin/../tsx/dist/cli.mjs watch src/index.ts" },
    { pid: 30, ppid: 1, command: "/bin/zsh -c pnpm dev:server &" },
    { pid: 31, ppid: 30, command: "node /bin/pnpm dev:server" },
    { pid: 32, ppid: 31, command: "node /repo/apps/server/node_modules/.bin/../tsx/dist/cli.mjs watch src/index.ts" },
  ];

  const candidates = new Set([11, 12, 13, 14, 30, 31, 32]);

  assert.deepEqual(selectRootPids(processes, candidates), [11, 30]);
});
