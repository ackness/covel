import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createSession } from "../../../modules/domain/src/index.js";
import { createRuntimeComposition } from "../src/composition.js";

const tempRoots: string[] = [];

describe("createRuntimeComposition package-owned resume", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("routes block resume through a package capability when resumeHandler is declared", async () => {
    const root = await createTempRoot();
    await writeResumePackage(root);

    const runtime = await createRuntimeComposition({
      cwd: root,
      env: {
        COVEL_ENABLED_PACKAGES: "resume-package"
      }
    });

    await runtime.repositories.sessions.save(createSession({
      id: "session_resume",
      worldId: "world_resume",
      status: "active",
      createdAt: new Date("2026-03-25T00:00:00.000Z")
    }));

    const initialEvents = await runtime.flowEngine.handle({
      requestId: "req_resume_01",
      type: "execute_command",
      sessionId: "session_resume",
      locale: "en",
      payload: {
        command: "/choose",
        args: {}
      }
    });

    const emittedBlock = initialEvents.find((event) => event.type === "block.emitted")?.payload.block as {
      id: string;
      type: string;
      meta: { turnId: string };
    };
    expect(emittedBlock).toBeDefined();

    const resumeEvents = await runtime.flowEngine.handle({
      requestId: "req_resume_02",
      type: "submit_block_response",
      sessionId: "session_resume",
      locale: "en",
      payload: {
        blockId: emittedBlock.id,
        blockType: emittedBlock.type,
        sessionId: "session_resume",
        turnId: emittedBlock.meta.turnId,
        response: {
          selected: "opt_a"
        }
      }
    });

    expect(resumeEvents.map((event) => event.type)).toEqual([
      "flow.phase.changed",
      "workflow.resumed",
      "message.completed",
      "flow.completed"
    ]);
    expect(resumeEvents[2]?.payload).toMatchObject({
      content: "handled:opt_a"
    });
  });

  it("rejects package-owned block responses that fail the registered response schema", async () => {
    const root = await createTempRoot();
    await writeResumePackage(root);

    const runtime = await createRuntimeComposition({
      cwd: root,
      env: {
        COVEL_ENABLED_PACKAGES: "resume-package"
      }
    });

    await runtime.repositories.sessions.save(createSession({
      id: "session_resume",
      worldId: "world_resume",
      status: "active",
      createdAt: new Date("2026-03-25T00:00:00.000Z")
    }));

    const initialEvents = await runtime.flowEngine.handle({
      requestId: "req_resume_invalid_01",
      type: "execute_command",
      sessionId: "session_resume",
      locale: "en",
      payload: {
        command: "/choose",
        args: {}
      }
    });

    const emittedBlock = initialEvents.find((event) => event.type === "block.emitted")?.payload.block as {
      id: string;
      type: string;
      meta: { turnId: string };
    };

    const resumeEvents = await runtime.flowEngine.handle({
      requestId: "req_resume_invalid_02",
      type: "submit_block_response",
      sessionId: "session_resume",
      locale: "en",
      payload: {
        blockId: emittedBlock.id,
        blockType: emittedBlock.type,
        sessionId: "session_resume",
        turnId: emittedBlock.meta.turnId,
        response: {}
      }
    });

    expect(resumeEvents.map((event) => event.type)).toEqual([
      "flow.phase.changed",
      "flow.failed"
    ]);
    expect(resumeEvents[1]?.payload).toMatchObject({
      code: "BLOCK_RESPONSE_SCHEMA_INVALID"
    });
    expect(String(resumeEvents[1]?.payload.message ?? "")).toContain("$.selected is required.");
  });
});

async function createTempRoot() {
  const root = await mkdtemp(join(tmpdir(), "covel-runtime-package-resume-"));
  tempRoots.push(root);
  return root;
}

async function writeResumePackage(root: string) {
  const packageRoot = join(root, "extensions", "resume-package");
  await mkdir(join(packageRoot, "server", "commands"), { recursive: true });
  await mkdir(join(packageRoot, "server", "capabilities"), { recursive: true });
  await mkdir(join(packageRoot, "schemas", "commands"), { recursive: true });
  await mkdir(join(packageRoot, "schemas", "capabilities"), { recursive: true });
  await mkdir(join(packageRoot, "schemas", "blocks"), { recursive: true });

  await writeFile(join(packageRoot, "manifest.json"), JSON.stringify({
    schemaVersion: "1.0",
    name: "resume-package",
    version: "0.1.0",
    description: "Package-owned resume package",
    kind: "interaction",
    defaultEnabled: true,
    scopes: ["session"],
    permissions: ["emit:block"],
    dependencies: [],
    modelPolicy: {
      preferredTier: "small"
    },
    contributes: {
      commands: [
        {
          name: "choose",
          description: "Emit a resumable choice block",
          argsSchema: "schemas/commands/choose.args.json",
          entry: "server/commands/choose.ts",
          resume: false
        }
      ],
      capabilities: [
        {
          id: "resume-package.resume-choice",
          type: "workflow",
          entry: "server/capabilities/resume-choice.ts",
          inputSchema: "schemas/capabilities/resume-choice.input.json",
          outputSchema: "schemas/capabilities/resume-choice.output.json"
        }
      ],
      blockTypes: [
        {
          type: "choice_set",
          dataSchema: "schemas/blocks/choice-set.data.json",
          responseSchema: "schemas/blocks/choice-set.response.json",
          resume: {
            handler: "resume-package.resume-choice"
          },
          ui: {
            component: "schema",
            renderer: "choice-set"
          }
        }
      ],
      hooks: [],
      contextProviders: [],
      renderers: [],
      artifactTypes: []
    },
    settings: [],
    state: []
  }, null, 2), "utf8");
  await writeFile(join(packageRoot, "SKILL.md"), "# Resume Package", "utf8");
  await writeFile(join(packageRoot, "schemas", "commands", "choose.args.json"), JSON.stringify({ type: "object" }, null, 2), "utf8");
  await writeFile(join(packageRoot, "schemas", "capabilities", "resume-choice.input.json"), JSON.stringify({ type: "object" }, null, 2), "utf8");
  await writeFile(join(packageRoot, "schemas", "capabilities", "resume-choice.output.json"), JSON.stringify({ type: "object" }, null, 2), "utf8");
  await writeFile(join(packageRoot, "schemas", "blocks", "choice-set.data.json"), JSON.stringify({
    type: "object",
    additionalProperties: false,
    properties: {
      title: {
        type: "string"
      },
      options: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: {
              type: "string"
            },
            label: {
              type: "string"
            }
          },
          required: ["id", "label"]
        }
      }
    },
    required: ["title", "options"]
  }, null, 2), "utf8");
  await writeFile(join(packageRoot, "schemas", "blocks", "choice-set.response.json"), JSON.stringify({
    type: "object",
    additionalProperties: false,
    properties: {
      selected: {
        type: "string"
      }
    },
    required: ["selected"]
  }, null, 2), "utf8");

  await writeFile(join(packageRoot, "server", "commands", "choose.ts"), [
    "export const command = {",
    "  argsSchema: {",
    "    safeParse(value) {",
    "      return { success: true, data: value ?? {} };",
    "    }",
    "  },",
    "  async execute() {",
    "    return {",
    "      content: \"choose emitted\",",
    "      blocks: [",
    "        {",
    "          id: \"blk_choice\",",
    "          type: \"choice_set\",",
    "          version: \"1.0\",",
    "          meta: {",
    "            package: \"resume-package\",",
    "            requestId: \"req_local\",",
    "            traceId: \"tr_local\",",
    "            sessionId: \"session_resume\",",
    "            turnId: \"turn_local\"",
    "          },",
    "          interaction: {",
    "            requiresResponse: true,",
    "            responseSchema: \"schemas/blocks/choice-set.response.json\",",
    "            submitAs: \"block_response\",",
    "            resumePolicy: \"resume_current_flow\",",
    "            resumeHandler: \"resume-package.resume-choice\"",
    "          },",
    "          data: {",
    "            title: \"Choose\",",
    "            options: [",
    "              { id: \"opt_a\", label: \"Advance\" }",
    "            ]",
    "          }",
    "        }",
    "      ]",
    "    };",
    "  }",
    "};",
    ""
  ].join("\n"), "utf8");

  await writeFile(join(packageRoot, "server", "capabilities", "resume-choice.ts"), [
    "export const capability = {",
    "  async execute(input) {",
    "    return {",
    "      content: `handled:${String(input.response.response.selected ?? \"unknown\")}`",
    "    };",
    "  }",
    "};",
    ""
  ].join("\n"), "utf8");
}
