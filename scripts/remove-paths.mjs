import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const targets = process.argv.slice(2);

if (targets.length === 0) {
	console.error("Usage: node scripts/remove-paths.mjs <path> [more-paths...]");
	process.exit(1);
}

for (const target of targets) {
	fs.rmSync(path.resolve(process.cwd(), target), {
		recursive: true,
		force: true,
	});
}
