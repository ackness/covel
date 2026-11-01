import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Select up to two allowed CPUs without expanding potentially large ranges. */
export function parseAllowedCpuList(status) {
  const fields = status
    .split("\n")
    .filter((line) => line.startsWith("Cpus_allowed_list:"));
  if (fields.length !== 1)
    throw new Error("Missing or duplicate Cpus_allowed_list");
  const list = fields[0].slice("Cpus_allowed_list:".length).trim();
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(list))
    throw new Error("Malformed or empty Cpus_allowed_list");
  const selected = [];
  let previous = -1;
  for (const part of list.split(",")) {
    const [start, end = start] = part.split("-").map(Number);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start <= previous ||
      end < start
    )
      throw new Error("Invalid Cpus_allowed_list range or ordering");
    previous = end;
    for (let cpu = start; cpu <= end && selected.length < 2; cpu += 1)
      selected.push(cpu);
  }
  return selected.join(",");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== "linux")
      throw new Error("CPU affinity requires Linux");
    console.log(parseAllowedCpuList(readFileSync("/proc/self/status", "utf8")));
  } catch (error) {
    console.error(`Cannot constrain browser CPUs: ${error.message}`);
    process.exitCode = 1;
  }
}
