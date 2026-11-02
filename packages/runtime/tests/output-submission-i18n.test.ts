import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentOutputContract,
  outputToolDefinition,
} from "../src/agent-loop/agent-output-contract.js";
import { evaluateSubmission } from "../src/agent-loop/output-submission.js";
import { manifest } from "./_helpers/agent-loop-fixture.js";

afterEach(() => vi.unstubAllEnvs());

describe("submission instruction language", () => {
  it.each([
    ["zh-CN", undefined, true],
    ["zh-Hans", undefined, true],
    ["zh-TW", undefined, false],
    ["en-US", undefined, false],
    ["ru-RU", undefined, false],
    [undefined, undefined, false],
    ["zh-CN", "en", false],
    ["en-US", "zh", true],
  ] as const)(
    "localizes %s with override %s",
    async (locale, override, chinese) => {
      vi.stubEnv("COVEL_INSTRUCTION_LOCALE", override ?? "");
      const runtime = manifest({
        requireToolUse: true,
        completeAfterTools: ["save-facts", "sync-records"],
      });
      const contract = agentOutputContract({
        manifest: runtime,
        promptTemplate: "",
      });
      const definition = await outputToolDefinition(contract, locale);
      expect(definition.description).toContain(
        chinese ? "提交本 runtime 的最终结果" : "Submit the final result",
      );
      const attempt = (argumentsJson: string) => {
        const call = {
          id: "final",
          name: "submit-output",
          arguments: argumentsJson,
        };
        return evaluateSubmission({
          contract,
          manifest: runtime,
          call,
          originalCall: call,
          requiredWorkMet: false,
          publicToolResults: [],
          businessCalls: [],
          locale,
          hookOpts: {
            pipeline: undefined,
            sessionId: "s",
            turnId: "t",
            pluginId: runtime.pluginId,
            runtimeId: runtime.name,
          },
        });
      };
      const shape = await attempt("[]");
      expect(shape).toMatchObject({
        rejection: {
          code: "invalid-output",
          message: chinese
            ? "参数必须是一个完整 JSON 对象。"
            : "Arguments must be one complete JSON object.",
        },
      });
      const work = await attempt("{}");
      expect(work).toMatchObject({
        rejection: {
          code: "required-work",
          message: expect.stringContaining(
            chinese
              ? "不要重复已成功的写入"
              : "Do not repeat successful writes",
          ),
        },
      });
      if ("rejection" in work) {
        expect(work.rejection.message).toContain("save-facts, sync-records");
        expect(work.rejection.message).not.toContain("{{");
      }
      if (!chinese)
        expect(JSON.stringify([definition, shape, work])).not.toMatch(
          /\p{Script=Han}/u,
        );
    },
  );

  it.each(["en-US", "zh-CN"])(
    "renders the any-business-tool prerequisite in %s",
    async (locale) => {
      const runtime = manifest({ requireToolUse: true });
      const contract = agentOutputContract({
        manifest: runtime,
        promptTemplate: "",
      });
      const call = { id: "final", name: "submit-output", arguments: "{}" };
      const result = await evaluateSubmission({
        contract,
        manifest: runtime,
        call,
        originalCall: call,
        requiredWorkMet: false,
        publicToolResults: [],
        businessCalls: [],
        locale,
        hookOpts: {
          pipeline: undefined,
          sessionId: "s",
          turnId: "t",
          pluginId: runtime.pluginId,
          runtimeId: runtime.name,
        },
      });
      expect(result).toMatchObject({
        rejection: {
          code: "required-work",
          message: expect.stringContaining(
            locale === "zh-CN"
              ? "业务工具工作，并解决"
              : "business tool work successfully",
          ),
        },
      });
    },
  );
});

it.each(["en-US", "zh-CN"])(
  "localizes sourced submission instructions and rejections in %s",
  async (locale) => {
    const runtime = manifest({ output: { from: { tool: "mark" } } });
    const contract = agentOutputContract({
      manifest: runtime,
      promptTemplate: "",
      outputSchema: { type: "object" },
    });
    const definition = await outputToolDefinition(contract, locale);
    expect(definition.description).toContain(
      locale === "zh-CN" ? "成功后" : "succeeds",
    );
    expect(definition.description).toContain("mark");
    const call = { id: "final", name: "submit-output", arguments: "{}" };
    const args = {
      contract,
      manifest: runtime,
      call,
      originalCall: call,
      requiredWorkMet: true,
      publicToolResults: [],
      businessCalls: [],
      locale,
      hookOpts: {
        pipeline: undefined,
        sessionId: "s",
        turnId: "t",
        pluginId: runtime.pluginId,
        runtimeId: runtime.name,
      },
    };
    expect(await evaluateSubmission(args)).toMatchObject({
      rejection: {
        code: "required-work",
        correction: "toolUse",
        message: expect.stringContaining(
          locale === "zh-CN" ? "请先成功调用" : "Call mark successfully",
        ),
      },
    });
    expect(
      await evaluateSubmission({
        ...args,
        call: { ...call, arguments: '{"extra":true}' },
      }),
    ).toMatchObject({
      rejection: {
        code: "required-work",
        correction: "toolUse",
        message: expect.stringContaining(
          locale === "zh-CN" ? "请先成功调用" : "Call mark successfully",
        ),
      },
    });
  },
);
