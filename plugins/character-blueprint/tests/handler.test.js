import { describe, expect, it } from "vitest";
import { getPendingProposals } from "@covel/tools";
import handler from "../handler.js";

function ctx(manualPayload) {
	return {
		sessionId: "sess-blueprint",
		turnId: "turn-blueprint",
		pluginId: "character-blueprint",
		runtimeId: "character-blueprint/import",
		playerMessage: "",
		completedResults: new Map(),
		config: {},
		manualPayload,
	};
}

describe("character-blueprint handler", () => {
	it("imports a blueprint into plugin data", async () => {
		const result = await handler(
			ctx({
				blueprint: {
					schemaVersion: 1,
					id: "mentor-lin",
					name: "Lin Yue",
					role: "npc",
					persona: { summary: "A precise sword mentor." },
				},
			}),
		);

		expect(result).toEqual({
			imported: true,
			blueprintId: "mentor-lin",
			instantiated: false,
		});

		const proposals = getPendingProposals(result);
		expect(proposals).toHaveLength(1);
		expect(proposals[0]).toMatchObject({
			type: "plugin.data",
			sessionId: "sess-blueprint",
			turnId: "turn-blueprint",
			source: {
				pluginId: "character-blueprint",
				runtimeId: "character-blueprint/import",
			},
			payload: {
				namespace: "blueprints",
				key: "mentor-lin",
				value: {
					blueprint: {
						schemaVersion: 1,
						id: "mentor-lin",
						name: "Lin Yue",
						role: "npc",
						persona: { summary: "A precise sword mentor." },
					},
				},
			},
		});
		expect(proposals[0].payload.value.importedAt).toEqual(expect.any(String));
	});

	it("imports and instantiates through character.upsert", async () => {
		const result = await handler(
			ctx({
				instantiate: true,
				blueprint: {
					schemaVersion: 1,
					id: "mentor-lin",
					name: "Lin Yue",
					role: "npc",
					description: "A cautious sword mentor.",
					attributes: { realm: "Foundation" },
					dialogueExamples: [
						{
							user: "I can win quickly.",
							character: "Quickly is where errors hide.",
						},
					],
					instantiate: {
						characterId: "char-lin-yue",
						fields: { realm: "Golden Core" },
						mirrorPluginId: "other-plugin",
					},
				},
			}),
		);

		expect(result).toEqual({
			imported: true,
			blueprintId: "mentor-lin",
			instantiated: true,
			characterId: "char-lin-yue",
		});

		const proposals = getPendingProposals(result);
		expect(proposals).toHaveLength(2);
		expect(proposals[0]).toMatchObject({
			type: "plugin.data",
			source: {
				pluginId: "character-blueprint",
				runtimeId: "character-blueprint/import",
			},
			payload: {
				namespace: "blueprints",
				key: "mentor-lin",
				value: {
					instantiatedCharacterId: "char-lin-yue",
				},
			},
		});
		expect(proposals[1]).toMatchObject({
			type: "character.upsert",
			source: {
				pluginId: "character-blueprint",
				runtimeId: "character-blueprint/import",
			},
			payload: {
				id: "char-lin-yue",
				name: "Lin Yue",
				type: "npc",
				description: "A cautious sword mentor.",
				fields: { realm: "Golden Core" },
				version: 1,
				mirrorPluginId: "character-blueprint",
			},
		});
		expect(proposals[1].payload.createdAt).toEqual(expect.any(String));
	});

	it("imports from blueprintJson for json-render panels", async () => {
		const result = await handler(
			ctx({
				instantiate: true,
				blueprintJson: JSON.stringify({
					schemaVersion: 1,
					id: "json-mentor",
					name: "Json Mentor",
					role: "npc",
				}),
			}),
		);

		expect(result).toEqual({
			imported: true,
			blueprintId: "json-mentor",
			instantiated: true,
			characterId: "char-json-mentor",
		});
		const proposals = getPendingProposals(result);
		expect(proposals.map((proposal) => proposal.type)).toEqual([
			"plugin.data",
			"character.upsert",
		]);
	});

	it("rejects malformed blueprintJson payloads", async () => {
		await expect(handler(ctx({ blueprintJson: "{bad json" }))).rejects.toThrow(
			"manualPayload.blueprintJson must be valid JSON",
		);
	});

	it("rejects malformed blueprint payloads", async () => {
		await expect(
			handler(ctx({ blueprint: { id: "missing-name" } })),
		).rejects.toThrow("blueprint.name must be a non-empty string");
	});

	it("rejects unsafe ids and oversized blueprint payloads", async () => {
		await expect(
			handler(
				ctx({
					blueprint: { schemaVersion: 1, id: "../escape", name: "Escape" },
				}),
			),
		).rejects.toThrow("blueprint.id must be 1-128 characters");

		await expect(
			handler(
				ctx({
					blueprint: {
						schemaVersion: 1,
						id: "large-blueprint",
						name: "Large Blueprint",
						attributes: { text: "x".repeat(70_000) },
					},
				}),
			),
		).rejects.toThrow("blueprint is too large");
	});
});
