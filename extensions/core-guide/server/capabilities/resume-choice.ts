import { pickLocalizedText } from "../../../shared/locale.js";

export const capability = {
  async execute(
    input: {
      block?: {
        data?: {
          title?: string;
          options?: Array<{
            id: string;
            label: string;
          }>;
        };
      };
      response?: {
        response?: {
          selected?: string;
        };
      };
    },
    context: {
      sessionId?: string;
      locale?: string;
    }
  ) {
    const selectedId = String(input.response?.response?.selected ?? "");
    const options = input.block?.data?.options ?? [];
    const selectedLabel = options.find((option) => option.id === selectedId)?.label ?? selectedId;
    const topic = String(input.block?.data?.title ?? pickLocalizedText(context.locale, {
      "zh-CN": "当前局势",
      en: "current situation"
    }));

    return {
      content: pickLocalizedText(context.locale, {
        "zh-CN": `你选择了「${selectedLabel}」。接下来围绕「${topic}」推进叙事。`,
        en: `You chose "${selectedLabel}". Continue the scene around "${topic}".`
      }),
      statePatches: context.sessionId
        ? [
            {
              scope: "session" as const,
              ownerId: context.sessionId,
              packageName: "core-guide",
              collection: "guide_state",
              key: "latest-choice",
              op: "replace" as const,
              value: {
                selected: selectedId,
                label: selectedLabel,
                topic
              }
            }
          ]
        : []
    };
  }
};
