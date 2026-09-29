import { describe, expect, it } from "vitest";
import { projectRequestBody } from "../src/adapters/http/request-observation.js";
import { withTextRequestDefaults } from "../src/adapters/request-defaults.js";

describe("Google request observability and defaults", () => {
  it("retains native request structure while redacting signed URLs and unknown metadata", () => {
    const result = projectRequestBody(
      JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                fileData: {
                  fileUri: "https://files.example/image?token=synthetic",
                  mimeType: "image/png",
                },
              },
            ],
          },
        ],
        systemInstruction: { parts: [{ text: "Synthetic instruction" }] },
        generationConfig: {
          maxOutputTokens: 100,
          thinkingConfig: { thinkingLevel: "low" },
        },
        secretExtension: "synthetic-key",
      }),
    );
    expect(result).toMatchObject({
      complete: false,
      omittedFieldCount: 1,
      body: {
        contents: [
          {
            role: "user",
            parts: [{ fileData: { fileUri: "[redacted resource URL]" } }],
          },
        ],
        generationConfig: { maxOutputTokens: 100 },
      },
    });
    expect(result.body).not.toHaveProperty("secretExtension");
  });

  it("preserves explicit native thinking while unrelated generation config still accepts task defaults", () => {
    const params = {
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Extract" }],
      defaults: { reasoningEffort: "disabled" as const },
    };
    const configured = {
      ...params,
      providerRequestMetadata: {
        generationConfig: { thinkingConfig: { thinkingBudget: 1024 } },
      },
    };
    expect(withTextRequestDefaults(configured)).toBe(configured);
    expect(
      withTextRequestDefaults({
        ...params,
        providerRequestMetadata: { generationConfig: { temperature: 0.2 } },
      }).providerRequestMetadata,
    ).toMatchObject({ reasoningEffort: "none" });
  });
});
