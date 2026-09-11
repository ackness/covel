#!/usr/bin/env node

/**
 * Preflight check for `pnpm dev:pg`. The server only speaks PostgreSQL
 * when STORE_BACKEND=pg, so if the local Postgres isn't up yet we print
 * the exact fix instead of letting the server crash 10 seconds later
 * with "ECONNREFUSED 127.0.0.1:5432". Missing check is cheap; silent
 * failure is expensive.
 */

import { createConnection } from "node:net";
import process from "node:process";

if (process.env.COVEL_PG_PREFLIGHT_SKIP === "1") {
  process.exit(0);
}

// Follow the same connection URL as the server; explicit probe overrides win.
let database;
try {
  database = process.env.DATABASE_URL
    ? new URL(process.env.DATABASE_URL)
    : undefined;
  if (database && !["postgres:", "postgresql:"].includes(database.protocol)) {
    throw new Error("Unsupported database protocol");
  }
} catch {
  console.error("[dev:pg] DATABASE_URL must be a valid PostgreSQL URL.");
  process.exit(1);
}
const host =
  process.env.COVEL_PG_PREFLIGHT_HOST ||
  database?.hostname.replace(/^\[|\]$/g, "") ||
  "127.0.0.1";
const port = Number(
  process.env.COVEL_PG_PREFLIGHT_PORT ||
    (database ? database.port || 5432 : process.env.POSTGRES_PORT || 5432),
);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("[dev:pg] PostgreSQL port must be an integer from 1 to 65535.");
  process.exit(1);
}
const timeoutMs = 1500;

/**
 * Returns true iff a TCP handshake to host:port succeeds within timeoutMs.
 */
function canConnect() {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finalize = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finalize(true));
    socket.once("timeout", () => finalize(false));
    socket.once("error", () => finalize(false));
  });
}

const ok = await canConnect();
if (!ok) {
  const msg = [
    "",
    `  [dev:pg] Postgres at ${host}:${port} is not reachable.`,
    "",
    "  Start the docker Postgres first:",
    "",
    "      pnpm db:up",
    "",
    "  Or set COVEL_PG_PREFLIGHT_HOST / PORT if your Postgres lives elsewhere,",
    "  or COVEL_PG_PREFLIGHT_SKIP=1 to bypass this check.",
    "",
  ].join("\n");
  // eslint-disable-next-line no-console
  console.error(msg);
  process.exit(1);
}
