/**
 * World package generator — uses LLM to create world.yaml + WORLD.md,
 * validates against worldManifestSchema, and writes to disk.
 *
 * Only requires a concept string. The LLM autonomously decides
 * all details (id, name, tags, dimensions, lore).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { validateWorldManifest, formatValidationErrors } from "@covel/shared";
import type { CreateWorldOptions, CreateResult } from "./types.js";
import { buildWorldPrompt } from "./prompts.js";

const MAX_RETRIES = 2;

function log(
	options: CreateWorldOptions,
	level: "info" | "warn" | "error",
	...args: unknown[]
): void {
	options.logger?.[level](...args);
}

function parseWorldOutput(raw: string): { yaml: string; lore: string } | null {
	const yamlMatch = raw.match(/===WORLD_YAML===\s*([\s\S]*?)\s*===WORLD_MD===/);
	const loreMatch = raw.match(/===WORLD_MD===\s*([\s\S]*?)\s*===END===/);
	if (!yamlMatch || !loreMatch) return null;
	return {
		yaml: yamlMatch[1].trim(),
		lore: loreMatch[1].trim(),
	};
}

/**
 * If the manifest contains inline `dimensions`, extract each key into its own
 * file under <worldDir>/dimensions/ and rewrite the manifest to use
 * `dimensionSources` instead. Keeps the manifest tidy and matches the
 * reference world package layout (e.g. neonridge/dimensions/*.yaml).
 */
async function extractAndWriteDimensions(
	worldDir: string,
	manifest: Record<string, unknown>,
): Promise<string[]> {
	const inline = manifest.dimensions as Record<string, unknown> | undefined;
	if (
		!inline ||
		typeof inline !== "object" ||
		Object.keys(inline).length === 0
	) {
		return [];
	}

	const dimDir = path.join(worldDir, "dimensions");
	await mkdir(dimDir, { recursive: true });

	const sources: Record<string, string> = {};
	const written: string[] = [];

	for (const [key, data] of Object.entries(inline)) {
		if (data === undefined || data === null) continue;
		const fileName = `${key}.yaml`;
		const filePath = path.join(dimDir, fileName);
		await writeFile(filePath, stringifyYaml(data, { lineWidth: 0 }), "utf-8");
		sources[key] = `./dimensions/${fileName}`;
		written.push(path.relative(worldDir, filePath));
	}

	delete manifest.dimensions;
	manifest.dimensionSources = sources;

	return written;
}

export async function createWorld(
	options: CreateWorldOptions,
): Promise<CreateResult> {
	const locale = options.locale ?? "zh-CN";
	const prompt = buildWorldPrompt(options.concept, locale);
	log(
		options,
		"info",
		'start concept="',
		options.concept,
		'" locale=',
		locale,
		"model=",
		options.model ?? "default",
	);

	let lastErrors: string[] = [];

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		log(
			options,
			"info",
			`attempt ${attempt + 1}/${MAX_RETRIES + 1}: sending LLM request`,
		);
		const llmStart = Date.now();

		const messages = [
			{ role: "system" as const, content: prompt },
			...(attempt > 0
				? [
						{
							role: "user" as const,
							content: `The previous output had validation errors:\n${lastErrors.join("\n")}\n\nPlease fix and regenerate.`,
						},
					]
				: [{ role: "user" as const, content: options.concept }]),
		];

		let response;
		try {
			response = await options.llm.generate({
				model: options.model,
				messages,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log(options, "error", `LLM generate() threw: ${msg}`);
			lastErrors = [`LLM error: ${msg}`];
			continue;
		}

		log(
			options,
			"info",
			`LLM responded in ${Date.now() - llmStart}ms contentLength=${response.content?.length ?? 0}`,
		);

		if (!response.content) {
			lastErrors = ["LLM returned empty response"];
			log(options, "warn", "attempt", attempt + 1, "empty response");
			continue;
		}

		const parsed = parseWorldOutput(response.content);
		if (!parsed) {
			lastErrors = [
				"Failed to parse output — expected ===WORLD_YAML=== and ===WORLD_MD=== delimiters",
			];
			log(
				options,
				"warn",
				"attempt",
				attempt + 1,
				"parseWorldOutput failed (delimiters missing)",
			);
			continue;
		}

		log(
			options,
			"info",
			"parsed OK: yamlLength=",
			parsed.yaml.length,
			"loreLength=",
			parsed.lore.length,
		);

		// Parse and validate YAML
		let yamlData: Record<string, unknown>;
		try {
			yamlData = parseYaml(parsed.yaml) as Record<string, unknown>;
		} catch (err) {
			lastErrors = [
				`Invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
			];
			log(
				options,
				"warn",
				"attempt",
				attempt + 1,
				"YAML parse failed:",
				lastErrors[0],
			);
			continue;
		}

		log(
			options,
			"info",
			"YAML parsed, keys=",
			Object.keys(yamlData).join(", "),
		);

		const validation = validateWorldManifest(yamlData);
		if (!validation.valid) {
			lastErrors = formatValidationErrors(validation.errors!).split("\n");
			log(
				options,
				"warn",
				"attempt",
				attempt + 1,
				"validation failed with",
				lastErrors.length,
				"errors",
			);
			continue;
		}

		// Extract id from validated data
		const id = yamlData.id as string;
		const lang = locale.split("-")[0];
		log(options, "info", `validation passed id=${id}`);

		// Write files
		const worldDir = path.join(options.outputDir, id);
		log(options, "info", "writing to", worldDir);
		await mkdir(worldDir, { recursive: true });

		const writtenFiles: string[] = [];

		// If dimensions are inline, extract them to separate files and rewrite manifest
		const dimFiles = await extractAndWriteDimensions(worldDir, yamlData);
		if (dimFiles.length > 0) {
			log(options, "info", "extracted dimensions to", dimFiles);
			writtenFiles.push(...dimFiles.map((f) => `${id}/${f}`));
		}

		// Re-serialize manifest (may now contain dimensionSources instead of dimensions)
		const finalYaml = stringifyYaml(yamlData, { lineWidth: 0 });
		await writeFile(path.join(worldDir, "world.yaml"), finalYaml, "utf-8");
		writtenFiles.push(`${id}/world.yaml`);

		await writeFile(
			path.join(worldDir, `WORLD.${lang}.md`),
			parsed.lore,
			"utf-8",
		);
		writtenFiles.push(`${id}/WORLD.${lang}.md`);
		await writeFile(path.join(worldDir, "WORLD.md"), parsed.lore, "utf-8");
		writtenFiles.push(`${id}/WORLD.md`);

		log(options, "info", `done wrote ${writtenFiles.length} files`);

		return {
			success: true,
			files: writtenFiles,
			id,
		};
	}

	log(options, "error", `all ${MAX_RETRIES + 1} attempts exhausted`);
	return {
		success: false,
		files: [],
		errors: lastErrors,
		id: "unknown",
	};
}
