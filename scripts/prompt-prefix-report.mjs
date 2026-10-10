// Reports, for every runtime of a recorded session, how much of each turn's first model request
// repeats the previous turn's request from the first character on.
//
// Provider prompt caches are prefix caches: a request reads from cache only the part that equals
// an earlier request from its start. The shared prefix is therefore the part a provider can
// cache, whatever the provider. The script reads the `llm.calling` trace events of a SQLite
// database, so it needs no model and no running server.
//
//   pnpm prompt:prefix <covel.db> [--session <id>] [--json] [--show <runtimeId>]
//
// Sizes are characters of the request as it was sent (tools, then messages in order); tokens are
// an estimate (see estimateTokens), not a provider's count.

import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

/** Rough token estimate: a CJK character is about one token, other text about four characters per token. */
export function estimateTokens(text) {
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk += 1;
    }
  }
  return Math.round(cjk + (text.length - cjk) / 4);
}

/**
 * The parts of a request in the order a provider hashes them: tool definitions, then each
 * message. A request body that was recorded is used as sent; otherwise the kernel's own view.
 */
export function requestParts(payload) {
  const body = payload.providerRequests?.find((request) => request?.body)?.body;
  const tools = body?.tools ?? payload.tools ?? [];
  const parts = tools.map((tool, index) => ({
    label: `tool ${index + 1} (${tool?.function?.name ?? tool?.name ?? "?"})`,
    text: JSON.stringify(tool),
  }));
  if (typeof body?.system === "string") {
    parts.push({ label: "system", text: body.system });
  } else if (Array.isArray(body?.system)) {
    for (const [index, block] of body.system.entries()) {
      parts.push({
        label: `system block ${index + 1}`,
        text: JSON.stringify(block),
      });
    }
  }
  if (typeof body?.instructions === "string") {
    parts.push({ label: "instructions", text: body.instructions });
  }
  const messages =
    body?.messages ?? body?.input ?? body?.contents ?? payload.messages ?? [];
  for (const [index, message] of messages.entries()) {
    const role = message?.role ?? message?.type ?? "?";
    const text =
      typeof message?.content === "string"
        ? message.content
        : JSON.stringify(message);
    parts.push({ label: `message ${index + 1} (${role})`, text });
  }
  return parts;
}

/** Where two requests stop being equal: shared characters, and the part and text at that point. */
export function comparePrefix(previous, current) {
  let shared = 0;
  for (const [index, part] of current.entries()) {
    const before = previous[index];
    if (before && before.text === part.text) {
      shared += part.text.length;
      continue;
    }
    let offset = 0;
    if (before) {
      const limit = Math.min(before.text.length, part.text.length);
      while (
        offset < limit &&
        before.text.charCodeAt(offset) === part.text.charCodeAt(offset)
      )
        offset += 1;
    }
    return {
      shared: shared + offset,
      label: part.label,
      offset,
      was: before
        ? before.text.slice(Math.max(0, offset - 40), offset + 80)
        : "(no such part)",
      now: part.text.slice(Math.max(0, offset - 40), offset + 80),
    };
  }
  return {
    shared,
    label:
      previous.length > current.length
        ? "(request ends earlier)"
        : "(identical)",
    offset: 0,
  };
}

function readCalls(dbPath, sessionId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db
    .prepare(
      `SELECT session_id AS sessionId, turn_id AS turnId, payload
         FROM trace_events
        WHERE type = 'llm.calling' ${sessionId ? "AND session_id = ?" : ""}
        ORDER BY created_at, seq`,
    )
    .all(...(sessionId ? [sessionId] : []));
  db.close();
  return rows;
}

/** One entry per (session, runtime): the first request of each turn the runtime ran in, in order. */
export function firstRequestsPerTurn(rows) {
  const runtimes = new Map();
  for (const row of rows) {
    const payload = JSON.parse(row.payload);
    // A retry repeats the request; only the first attempt of a turn opens the comparison.
    const key = `${row.sessionId}\u0000${payload.runtimeId}`;
    let entry = runtimes.get(key);
    if (!entry) {
      entry = {
        sessionId: row.sessionId,
        runtimeId: payload.runtimeId,
        turns: [],
        calls: 0,
        chars: 0,
      };
      runtimes.set(key, entry);
    }
    const parts = requestParts(payload);
    const size = parts.reduce((sum, part) => sum + part.text.length, 0);
    entry.calls += 1;
    entry.chars += size;
    if (entry.turns.at(-1)?.turnId !== row.turnId)
      entry.turns.push({ turnId: row.turnId, parts, size });
  }
  return [...runtimes.values()];
}

export function buildReport(rows) {
  return firstRequestsPerTurn(rows).map((entry) => {
    const pairs = [];
    for (const [index, turn] of entry.turns.entries()) {
      const previous = entry.turns[index - 1];
      if (!previous) continue;
      const diff = comparePrefix(previous.parts, turn.parts);
      pairs.push({
        size: turn.size,
        tokens: estimateTokens(turn.parts.map((part) => part.text).join("")),
        shared: diff.shared,
        sharedTokens: estimateTokens(
          turn.parts
            .map((part) => part.text)
            .join("")
            .slice(0, diff.shared),
        ),
        firstDifference: diff.label,
        offset: diff.offset,
        was: diff.was,
        now: diff.now,
      });
    }
    return {
      sessionId: entry.sessionId,
      runtimeId: entry.runtimeId,
      turns: entry.turns.length,
      calls: entry.calls,
      totalChars: entry.chars,
      firstRequestChars: entry.turns.map((turn) => turn.size),
      pairs,
    };
  });
}

function printTable(report, showRuntime) {
  const sum = (values) => values.reduce((total, value) => total + value, 0);
  const lines = [];
  for (const sessionId of new Set(report.map((entry) => entry.sessionId))) {
    const entries = report.filter((entry) => entry.sessionId === sessionId);
    lines.push(`\nSession ${sessionId}`);
    lines.push(
      [
        "runtime".padEnd(34),
        "turns",
        "calls",
        "req tok".padStart(8),
        "shared".padStart(8),
        "  %",
        " first difference",
      ].join(" "),
    );
    let allTokens = 0;
    let allShared = 0;
    for (const entry of entries) {
      if (entry.pairs.length === 0) {
        lines.push(
          [
            entry.runtimeId.padEnd(34),
            String(entry.turns).padStart(5),
            String(entry.calls).padStart(5),
            "(one turn only)",
          ].join(" "),
        );
        continue;
      }
      const tokens = sum(entry.pairs.map((pair) => pair.tokens));
      const shared = sum(entry.pairs.map((pair) => pair.sharedTokens));
      allTokens += tokens;
      allShared += shared;
      const count = entry.pairs.length;
      const last = entry.pairs.at(-1);
      lines.push(
        [
          entry.runtimeId.padEnd(34),
          String(entry.turns).padStart(5),
          String(entry.calls).padStart(5),
          String(Math.round(tokens / count)).padStart(8),
          String(Math.round(shared / count)).padStart(8),
          String(Math.round((100 * shared) / Math.max(1, tokens))).padStart(3),
          ` ${last.firstDifference} +${last.offset}`,
        ].join(" "),
      );
    }
    lines.push(
      `first request of each later turn: ${allTokens} estimated tokens, ${allShared} (${Math.round(
        (100 * allShared) / Math.max(1, allTokens),
      )}%) repeat the previous turn from the start`,
    );
  }
  if (showRuntime) {
    for (const entry of report.filter(
      (item) => item.runtimeId === showRuntime,
    )) {
      for (const [index, pair] of entry.pairs.entries()) {
        lines.push(
          `\n${entry.sessionId} ${entry.runtimeId} turn ${index + 1} -> ${index + 2}: ${pair.firstDifference} +${pair.offset}`,
        );
        lines.push(`  was: ${JSON.stringify(pair.was)}`);
        lines.push(`  now: ${JSON.stringify(pair.now)}`);
      }
    }
  }
  console.log(lines.join("\n"));
  console.log(
    "\nreq tok / shared: mean estimated tokens of a turn's first request, and of the part equal to the previous turn's.\n" +
      "These are prefix measurements on the recorded request, not a provider's bill.",
  );
}

function main(argv) {
  const args = argv.slice(2);
  const take = (flag) => {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    const [, value] = args.splice(index, 2);
    return value;
  };
  const sessionId = take("--session");
  const showRuntime = take("--show");
  const jsonIndex = args.indexOf("--json");
  if (jsonIndex !== -1) args.splice(jsonIndex, 1);
  const dbPath = args[0];
  if (!dbPath) {
    console.error(
      "usage: pnpm prompt:prefix <covel.db> [--session <id>] [--show <runtimeId>] [--json]",
    );
    process.exit(2);
  }
  const report = buildReport(readCalls(dbPath, sessionId));
  if (jsonIndex !== -1) console.log(JSON.stringify(report, null, 2));
  else printTable(report, showRuntime);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv);
