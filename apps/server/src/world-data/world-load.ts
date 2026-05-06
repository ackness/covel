import { homedir } from "node:os";
import path from "node:path";
import {
	formatValidationErrors,
	validateDimensions,
	type WorldDataMetadataSummary,
} from "@covel/shared";
import { digestFile, sha256Hex } from "./digest.js";
import { loadWorldDataDescriptor } from "./descriptor.js";
import { readWorldDataSource } from "./source-reader.js";
import {
	parseWorldDataIndexTarget,
	parseWorldDataTarget,
} from "./target-uri.js";
import { summarizeMediaSource } from "./media.js";
import type { OrderedWorldDataSource, WorldDataDiagnostic } from "./types.js";

function countDiagnostics(diagnostics: readonly WorldDataDiagnostic[]): {
	info: number;
	warning: number;
	error: number;
} {
	return {
		info: diagnostics.filter((diagnostic) => diagnostic.level === "info")
			.length,
		warning: diagnostics.filter((diagnostic) => diagnostic.level === "warning")
			.length,
		error: diagnostics.filter((diagnostic) => diagnostic.level === "error")
			.length,
	};
}

function setMetadataPath(
	metadata: Record<string, unknown>,
	segments: readonly string[],
	value: unknown,
): void {
	let current = metadata;
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i]!;
		const existing = current[segment];
		if (
			existing === null ||
			typeof existing !== "object" ||
			Array.isArray(existing)
		) {
			current[segment] = {};
		}
		current = current[segment] as Record<string, unknown>;
	}
	current[segments[segments.length - 1]!] = value;
}

function validateSourceSchema(
	source: OrderedWorldDataSource,
	value: unknown,
): readonly WorldDataDiagnostic[] {
	if (!source.descriptor.schema) return [];
	if (source.descriptor.schema === "covel://world/dimensions") {
		const validation = validateDimensions(value);
		if (!validation.valid) {
			return [
				{
					level: "error",
					sourceId: source.id,
					schema: source.descriptor.schema,
					message: `invalid world dimensions:\n${formatValidationErrors(validation.errors ?? [])}`,
				},
			];
		}
	}
	return [];
}

async function summarizeSource(
	source: OrderedWorldDataSource,
	metadata: Record<string, unknown>,
): Promise<{
	digest: string;
	diagnostics: readonly WorldDataDiagnostic[];
}> {
	const diagnostics: WorldDataDiagnostic[] = [];
	const parsedTarget = parseWorldDataTarget(source.descriptor.to);
	if (!parsedTarget) {
		diagnostics.push({
			level: "error",
			sourceId: source.id,
			message: `invalid target URI: ${source.descriptor.to}`,
		});
	}
	if (
		source.descriptor.indexTo &&
		!parseWorldDataIndexTarget(source.descriptor.indexTo)
	) {
		diagnostics.push({
			level: "error",
			sourceId: source.id,
			message: `invalid indexTo URI: ${source.descriptor.indexTo}`,
		});
	}

	const read = await readWorldDataSource(source);
	diagnostics.push(...read.diagnostics);
	if (!read.path) {
		return { digest: sha256Hex(`${source.id}:missing`), diagnostics };
	}

	if (source.descriptor.kind === "media") {
		const media = await summarizeMediaSource(source, read.path);
		diagnostics.push(...media.diagnostics);
		return {
			digest: media.summary?.digest ?? (await digestFile(read.path)).digest,
			diagnostics,
		};
	}

	diagnostics.push(...validateSourceSchema(source, read.value));
	const digest = await digestFile(read.path);
	if (
		parsedTarget?.kind === "world-metadata" &&
		parsedTarget.path.join(".") === "dimensions" &&
		diagnostics.every((d) => d.level !== "error")
	) {
		setMetadataPath(metadata, parsedTarget.path, read.value);
	} else if (parsedTarget?.kind === "world-metadata") {
		diagnostics.push({
			level: "warning",
			sourceId: source.id,
			message: `world-load MVP only projects world:metadata.dimensions; ${source.descriptor.to} is recorded in summary only`,
		});
	}
	return { digest: digest.digest, diagnostics };
}

export async function loadWorldDataSummary(options: {
	worldRoot: string;
	worldId: string;
	worldDataPath?: string;
	covelHome?: string;
	metadata?: Record<string, unknown>;
	now?: string;
}): Promise<{
	metadata: Record<string, unknown>;
	summary?: WorldDataMetadataSummary;
	diagnostics: readonly WorldDataDiagnostic[];
}> {
	const metadata = { ...options.metadata };
	if (!options.worldDataPath) {
		return { metadata, diagnostics: [] };
	}

	const descriptor = await loadWorldDataDescriptor({
		worldRoot: options.worldRoot,
		worldId: options.worldId,
		worldDataPath: options.worldDataPath,
		covelHome:
			options.covelHome ??
			process.env.COVEL_HOME ??
			path.join(homedir(), ".covel"),
	});
	const allDiagnostics: WorldDataDiagnostic[] = [...descriptor.diagnostics];
	const sources: Array<WorldDataMetadataSummary["sources"][number]> = [];
	const importedAt = options.now ?? new Date().toISOString();

	for (const source of descriptor.sources) {
		const result = await summarizeSource(source, metadata);
		const sourceDiagnostics = [
			...descriptor.diagnostics.filter(
				(diagnostic) => diagnostic.sourceId === source.id,
			),
			...result.diagnostics,
		];
		allDiagnostics.push(...result.diagnostics);
		sources.push({
			id: source.id,
			digest: result.digest,
			target: source.descriptor.to,
			...(source.descriptor.schema ? { schema: source.descriptor.schema } : {}),
			importedAt,
			order: source.resolvedOrder,
			origin: source.origin,
			...(source.overridden ? { overridden: true } : {}),
			diagnostics: countDiagnostics(sourceDiagnostics),
		});
	}

	return {
		metadata: {
			...metadata,
			worldData: {
				schemaVersion: 1,
				sources,
			} satisfies WorldDataMetadataSummary,
		},
		summary: { schemaVersion: 1, sources },
		diagnostics: allDiagnostics,
	};
}
