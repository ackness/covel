import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  playerVisibleLore,
  type LLMAdapter,
  type LLMResponse,
} from "@covel/shared";
import { createWorld } from "./create-world.js";
import { repairWorldLore } from "./lore-repair.js";
import type { WorldGenerationDataContract } from "./types.js";

const yaml =
  'id: harbor\nname: Harbor\nversion: "0.1.0"\nsummary: A harbor.\ndefaultLocale: en-US';
const visible =
  "# Harbor\n\nA courier arrives.\n\n1. Meet her.\n2. Open the gate.\n3. Read the letter.";
const secret = "Chen is the anonymous witness.";
const lore = `${visible}\n\n<!-- narrator-only -->\n${secret}\n<!-- /narrator-only -->\n\nThe gate opens at dusk.`;
const current = { yaml, lore };
const patch = (lore: string, pack = "UNCHANGED", manifest = "UNCHANGED") =>
  `===WORLD_YAML===\n${manifest}\n===WORLD_MD===\n${lore}\n===WORLD_PACKAGE_YAML===\n${pack}\n===END===`;
const signal = new AbortController().signal;
function scripted(replies: readonly string[]) {
  const requests: Parameters<LLMAdapter["generate"]>[0][] = [];
  const llm: LLMAdapter = {
    async generate(request): Promise<LLMResponse> {
      const content =
        replies[Math.min(requests.length, replies.length - 1)] ?? "";
      requests.push(request);
      return {
        content,
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
  return { llm, requests };
}

describe("protected world revisions", () => {
  it.each([
    ["missing markers", lore.replace(/<!--[^\n]*-->/g, "")],
    [
      "same marker count with relocated secret",
      lore
        .replace(secret, "Wait for the reveal.")
        .replace("A courier arrives.", `A courier arrives. ${secret}`),
    ],
    [
      "visible-only rewrite",
      lore.replace("A courier arrives.", "Two couriers arrive."),
    ],
    [
      "reordered hidden region",
      `<!-- narrator-only -->\n${secret}\n<!-- /narrator-only -->\n${visible}`,
    ],
  ])(
    "refuses %s without full-document regeneration",
    async (_name, changed) => {
      const { llm, requests } = scripted([patch(changed)]);
      const result = await createWorld({
        llm,
        concept: "Harbor",
        locale: "en-US",
        revision: { current, instruction: "Update the courier." },
      });
      expect(result.success).toBe(false);
      expect(result.errors?.join(" ")).toContain(
        "Only edits inside existing hidden regions",
      );
      expect(requests).toHaveLength(1);
    },
  );

  it.each([
    "UNCHANGED",
    lore,
    lore.replace(secret, "Lin is the anonymous witness."),
  ])(
    "keeps visible prose while accepting a supported revision",
    async (changed) => {
      const { llm } = scripted([patch(changed)]);
      const result = await createWorld({
        llm,
        concept: "Harbor",
        locale: "en-US",
        revision: {
          current,
          instruction:
            "If needed, change the hidden witness to Lin; keep it hidden.",
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(playerVisibleLore(result.lore)).toBe(playerVisibleLore(lore));
      expect(result.lore).toContain(
        changed.includes("Lin is") ? "Lin is" : secret,
      );
    },
  );

  it("allows ordinary story revisions when there is no hidden source", async () => {
    const changed = visible.replace(
      "A courier arrives.",
      "Two couriers arrive.",
    );
    const { llm } = scripted([patch(changed)]);
    const result = await createWorld({
      llm,
      concept: "Harbor",
      locale: "en-US",
      revision: {
        current: { yaml, lore: visible },
        instruction: "Make it two couriers.",
      },
    });
    expect(result).toMatchObject({ success: true, lore: changed });
  });

  it("refuses malformed source before calling the model", async () => {
    const { llm, requests } = scripted([]);
    const result = await createWorld({
      llm,
      concept: "Harbor",
      revision: {
        current: {
          yaml,
          lore: `${visible}\n<!-- narrator-only -->\n${secret}`,
        },
        instruction: "Keep it.",
      },
    });
    expect(result.success).toBe(false);
    expect(result.errors?.join(" ")).toContain("fix the source markers");
    expect(requests).toEqual([]);
  });
});

describe("isolated lore repair", () => {
  it("repairs only the contaminated hidden fragment and restores the original boundary", async () => {
    const source = lore.replace(secret, `This lore is model output. ${secret}`);
    const { llm, requests } = scripted([
      `===WORLD_MD===\n${secret}\n===END===`,
    ]);
    const result = await repairWorldLore({
      llm,
      locale: "en-US",
      lore: source,
      errors: ["WORLD.md contains explicit generation meta wording"],
      signal,
    });
    expect(result).toEqual({ success: true, lore });
    expect(requests).toHaveLength(1);
    const prompt = String(requests[0]?.messages[1]?.content);
    expect(prompt).toContain(secret);
    expect(prompt).not.toContain("A courier arrives");
    expect(prompt).not.toContain("The gate opens");
  });

  it("does not give hidden facts to a visible-fragment repair", async () => {
    const source = lore.replace(
      "A courier arrives.",
      "This lore is model output. A courier arrives.",
    );
    const { llm, requests } = scripted([
      `===WORLD_MD===\n${visible}\n===END===`,
    ]);
    const result = await repairWorldLore({
      llm,
      locale: "en-US",
      lore: source,
      errors: ["meta wording"],
      signal,
    });
    expect(result).toEqual({ success: true, lore });
    expect(JSON.stringify(requests)).not.toContain(secret);
  });

  it.each([
    "not a delimited answer",
    `===WORLD_MD===\n<!-- /narrator-only -->\n${secret}\n<!-- narrator-only -->\n===END===`,
    "===WORLD_MD===\nThis lore is model output.\n===END===",
  ])(
    "fails a protected repair without an unsafe full-lore retry",
    async (answer) => {
      const source = lore.replace(
        secret,
        `This lore is model output. ${secret}`,
      );
      const { llm, requests } = scripted([
        patch(visible, "{}", yaml),
        patch(source),
        answer,
      ]);
      const result = await createWorld({
        llm,
        concept: "Harbor",
        locale: "en-US",
      });
      expect(result.success).toBe(false);
      expect(requests).toHaveLength(3);
    },
  );
});

const contract: WorldGenerationDataContract = {
  contract: "review.items@1",
  title: "Items",
  hint: "Count whole keys.",
  schema: {
    type: "object",
    properties: { id: { type: "string" }, count: { type: "integer" } },
    required: ["id", "count"],
    additionalProperties: false,
  },
  example: { id: "key", count: 1 },
  validate: (value: unknown) =>
    value !== null &&
    typeof value === "object" &&
    "count" in value &&
    Number.isInteger(value.count),
};
const record = (key: string, count: number) => ({
  contract: contract.contract,
  key,
  value: { id: key, count },
});

describe("world revision contract plan", () => {
  it("provides schema/hint/example, retries invalid data and preserves omitted records", async () => {
    const pack = {
      contractData: [record("key", 1), record("seal", 3)],
      characters: [{ id: "lin", name: "Lin", type: "npc" }],
    };
    const { llm, requests } = scripted([
      patch(
        "UNCHANGED",
        stringify({
          contractData: [
            { ...record("key", 1), value: { id: "key", count: "two" } },
          ],
        }),
      ),
      patch("UNCHANGED", stringify({ contractData: [record("key", 2)] })),
    ]);
    const result = await createWorld({
      llm,
      concept: "Harbor",
      locale: "en-US",
      dataContracts: [contract],
      revision: {
        current: { ...current, packageYaml: stringify(pack) },
        instruction: "Add one key.",
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.packageContent.contractData).toEqual([
      record("key", 2),
      record("seal", 3),
    ]);
    expect(result.packageContent.characters).toEqual(pack.characters);
    expect(requests).toHaveLength(2);
    const prompt = String(requests[0]?.messages[0]?.content);
    expect(prompt).toContain(JSON.stringify(contract.schema));
    expect(prompt).toContain(contract.hint);
    expect(prompt).toContain(JSON.stringify(contract.example));
    expect(prompt).not.toContain(
      "Return empty characters/lorebook/rules arrays",
    );
    expect(prompt).not.toContain("none requested. Omit contractData");
    expect(prompt).not.toContain("- CREATE contract");
  });

  it("deletes by contract and key, independently of the same key in another contract", async () => {
    const other = { ...contract, contract: "review.tools@1" };
    const kept = { ...record("key", 4), contract: other.contract };
    const { llm, requests } = scripted([
      patch(
        "UNCHANGED",
        stringify({
          contractData: [
            { contract: contract.contract, key: "key", remove: true },
          ],
        }),
      ),
    ]);
    const result = await createWorld({
      llm,
      concept: "Harbor",
      locale: "en-US",
      dataContracts: [contract, other],
      revision: {
        current: {
          ...current,
          packageYaml: stringify({ contractData: [record("key", 1), kept] }),
        },
        instruction: "Remove the item key, keeping the tool key.",
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.packageContent.contractData).toEqual([kept]);
    const request = String(requests[0]?.messages[1]?.content);
    const shape = request.match(/Remove a contract record with `([^`]+)`/);
    expect(shape).not.toBeNull();
    expect(Object.keys(parse(shape![1]!))).toEqual([
      "contract",
      "key",
      "remove",
    ]);
  });

  it.each(["UNCHANGED", "{}", "contractData: []\ncharacters: []"])(
    "preserves omitted data for %s",
    async (body) => {
      const { llm } = scripted([patch("UNCHANGED", body)]);
      const result = await createWorld({
        llm,
        concept: "Harbor",
        locale: "en-US",
        dataContracts: [contract],
        revision: {
          current: {
            ...current,
            packageYaml: stringify({ contractData: [record("key", 1)] }),
          },
          instruction: "Keep the contents.",
        },
      });
      expect(result.success).toBe(true);
      if (result.success)
        expect(result.packageContent.contractData).toEqual([record("key", 1)]);
    },
  );
});

describe("accepted generation context", () => {
  it("uses normalized IDs and permits references to existing characters", async () => {
    const notes: WorldGenerationDataContract = {
      contract: "review.notes@1",
      characterField: "notes",
      schema: { type: "object" },
      validate: (value: unknown) => value !== null && typeof value === "object",
    };
    const roster = [
      { id: "lin-xia", name: " Lin Xia " },
      { id: "chen", name: "Chen" },
    ];
    const { llm, requests } = scripted([
      patch(visible, "{}", yaml),
      patch(visible),
      patch("UNCHANGED", stringify({ characters: roster })),
      patch(
        "UNCHANGED",
        stringify({
          lorebook: [{ id: "gate", content: "The gate opens at dusk." }],
        }),
      ),
      // Rules share the lorebook namespace; this collision is normalized.
      patch(
        "UNCHANGED",
        stringify({
          rules: [{ id: "gate", content: "The gate closes at dawn." }],
        }),
      ),
      patch(
        "UNCHANGED",
        stringify({
          contractData: [
            {
              contract: notes.contract,
              key: "lin-xia",
              value: { friend: "chen", rule: "gate-2" },
            },
          ],
        }),
      ),
    ]);
    const result = await createWorld({
      llm,
      concept: "Harbor",
      locale: "en-US",
      brief: {
        content: ["characters", "lorebook", "rules"],
        contracts: [notes.contract],
      },
      dataContracts: [notes],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.packageContent.rules[0]?.id).toBe("gate-2");
    expect(result.packageContent.characters[0]).toMatchObject({
      id: "lin-xia",
      name: "Lin Xia",
      notes: { friend: "chen", rule: "gate-2" },
    });
    const request = String(requests[5]?.messages[1]?.content);
    const pack = parse(
      request.split("===WORLD_PACKAGE_YAML===\n")[1]!.split("\n===END===")[0]!,
    );
    expect(pack.rules[0].id).toBe(result.packageContent.rules[0]?.id);
    expect(pack.characters[0].name).toBe(
      result.packageContent.characters[0]?.name,
    );
    expect(request).not.toContain("do not use an `id` that is in them");
    expect(request).toContain("References to existing characters");
  });

  it("retries duplicate new character definitions without rejecting distinct IDs", async () => {
    const { llm, requests } = scripted([
      patch(visible, "{}", yaml),
      patch(visible),
      patch(
        "UNCHANGED",
        "characters: [{id: lin, name: Lin}, {id: lin, name: Other Lin}]",
      ),
      patch(
        "UNCHANGED",
        "characters: [{id: lin, name: Lin}, {id: chen, name: Chen}]",
      ),
    ]);
    const result = await createWorld({
      llm,
      concept: "Harbor",
      locale: "en-US",
      brief: { content: ["characters"] },
    });
    expect(result.success).toBe(true);
    expect(requests).toHaveLength(4);
    expect(String(requests[3]?.messages[3]?.content)).toContain(
      "duplicate character ids",
    );
    if (result.success)
      expect(result.packageContent.characters.map((c) => c.id)).toEqual([
        "lin",
        "chen",
      ]);
  });
});
