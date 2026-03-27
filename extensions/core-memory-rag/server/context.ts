import type {
  PackageContextFragment,
  PackageContextProviderExecutionContext,
  PackageContextProviderInput
} from "../../../modules/package-runtime/src/index.js";
import { pickLocalizedText } from "../../shared/locale.js";

export const contextProvider = {
  id: "memory-rag-context",
  async build(
    input: PackageContextProviderInput,
    context: PackageContextProviderExecutionContext
  ): Promise<PackageContextFragment[]> {
    const session = context.session;
    const repositories = context.repositories;
    if (!session || !repositories?.messages) {
      return [];
    }

    const allMessages = await repositories.messages.listBySessionId(session.id);
    const history = trimCurrentPrompt(allMessages, input.prompt).slice(-6);
    const fragments: PackageContextFragment[] = [];

    if (history.length > 0) {
      fragments.push({
        id: `recent-dialogue:${session.id}`,
        title: pickLocalizedText(input.locale, {
          "zh-CN": "最近回合记忆",
          en: "Recent turn memory"
        }),
        content: history
          .map((message) => `${formatRoleLabel(message.role, input.locale)}: ${message.content}`)
          .join("\n"),
        priority: 84,
        channel: "memory"
      });
    }

    if (repositories.memoryDocuments) {
      const memoryDocuments = [
        ...(await repositories.memoryDocuments.listByScope(`session:${session.id}`)),
        ...(session.worldId ? await repositories.memoryDocuments.listByScope(`world:${session.worldId}`) : [])
      ].slice(0, 3);

      if (memoryDocuments.length > 0) {
        fragments.push({
          id: `memory-docs:${session.id}`,
          title: pickLocalizedText(input.locale, {
            "zh-CN": "已索引记忆",
            en: "Indexed memory"
          }),
          content: memoryDocuments
            .map((document) => `## ${document.title}\n${truncate(document.content, 220)}`)
            .join("\n\n"),
          priority: 72,
          channel: "memory"
        });
      }
    }

    return fragments;
  }
};

export default contextProvider;

function trimCurrentPrompt(
  messages: Array<{ role: string; content: string }>,
  prompt: string
) {
  const lastMessage = messages.at(-1);
  if (lastMessage?.role === "user" && lastMessage.content === prompt) {
    return messages.slice(0, -1);
  }

  return messages;
}

function formatRoleLabel(role: string, locale: unknown): string {
  if (role === "assistant") {
    return pickLocalizedText(locale, {
      "zh-CN": "助手",
      en: "Assistant"
    });
  }

  if (role === "user") {
    return pickLocalizedText(locale, {
      "zh-CN": "玩家",
      en: "Player"
    });
  }

  return role;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength).trimEnd()}…`
    : value;
}
