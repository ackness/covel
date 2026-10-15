#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSync } from "oxc-parser";

const root = fileURLToPath(new URL("..", import.meta.url));

function propertyName(node) {
  return node.computed ? node.property?.value : node.property?.name;
}

/** World display fields need edition selection, even if their values are strings. */
export function sessionWorldTextProblems(filename, source) {
  const parsed = parseSync(filename, source);
  if (parsed.errors.length)
    throw new Error(`${filename}: ${parsed.errors[0].message}`);
  const problems = [];
  function visit(node, editionSelected = false) {
    const safe =
      editionSelected ||
      (node.type === "CallExpression" &&
        ["worldDisplayText", "localizedWorldText"].includes(node.callee?.name));
    if (
      !safe &&
      node.type === "MemberExpression" &&
      ["name", "description"].includes(propertyName(node)) &&
      (node.object?.name === "world" ||
        (node.object?.type === "MemberExpression" &&
          propertyName(node.object) === "world"))
    ) {
      const line = source.slice(0, node.start).split("\n").length;
      problems.push(
        `${filename}:${line}: use worldDisplayText(world, session.locale) for world labels`,
      );
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value)
          if (child && typeof child.type === "string") visit(child, safe);
      } else if (value && typeof value.type === "string") visit(value, safe);
    }
  }
  visit(parsed.program);
  return problems;
}

export function checkSessionWorldText(repoRoot = root) {
  const directory = path.join(repoRoot, "apps/web/src/components/session");
  const files = readdirSync(directory, { recursive: true })
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .filter((file) => !file.split(path.sep).includes("__tests__"))
    // This screen owns the world catalog and its dialogs, which follow UI language.
    .filter((file) => file !== "world-select-screen.tsx")
    .map((file) => path.join(directory, file));
  files.push(path.join(repoRoot, "apps/web/src/routes/session.tsx"));
  return files.flatMap((file) =>
    sessionWorldTextProblems(
      path.relative(repoRoot, file),
      readFileSync(file, "utf8"),
    ),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const problems = checkSessionWorldText();
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exitCode = 1;
  } else console.log("Session world labels select the played edition.");
}
