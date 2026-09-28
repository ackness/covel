import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

/** Check the canonical package owner's event resources once, without executing code. */
export function checkPluginEventSchemas(pluginRoot) {
  const manifestPath = path.join(pluginRoot, "PLUGIN.md");
  const errors = [];
  let checked = 0;
  let parsed;
  try {
    const text = fs.readFileSync(manifestPath, "utf8");
    const end = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
    if (end === -1) throw new Error("missing YAML frontmatter");
    parsed = YAML.parse(text.slice(3, end));
  } catch (error) {
    return { checked, errors: [`PLUGIN.md: ${error.message}`] };
  }
  const events = parsed?.contributes?.events;
  if (events !== undefined && !Array.isArray(events))
    return {
      checked,
      errors: ["PLUGIN.md contributes.events must be an array"],
    };
  for (const event of events ?? []) {
    checked++;
    const label = `PLUGIN.md contributes.events ${event?.topic ?? "(missing topic)"}`;
    if (typeof event?.schema !== "string") {
      errors.push(`${label}: missing schema path`);
      continue;
    }
    const schemaPath = path.resolve(pluginRoot, event.schema);
    let schema;
    try {
      schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    } catch (error) {
      errors.push(
        `${label}: cannot read JSON schema ${event.schema}: ${error.message}`,
      );
      continue;
    }
    // Preserve the preflight's structural check; runtime loading owns full schema compilation.
    if (
      !schema ||
      typeof schema !== "object" ||
      Array.isArray(schema) ||
      !("type" in schema || "properties" in schema)
    ) {
      errors.push(
        `${label}: schema ${event.schema} must contain type or properties`,
      );
    }
  }
  return { checked, errors };
}
