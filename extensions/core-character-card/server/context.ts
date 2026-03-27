import type {
  PackageContextFragment,
  PackageContextProviderExecutionContext,
  PackageContextProviderInput
} from "../../../modules/package-runtime/src/index.js";
import { pickLocalizedText } from "../../shared/locale.js";

export const contextProvider = {
  id: "character-card-context",
  async build(
    input: PackageContextProviderInput,
    context: PackageContextProviderExecutionContext
  ): Promise<PackageContextFragment[]> {
    const session = context.session;
    const repositories = context.repositories;
    if (!session || !repositories) {
      return [];
    }

    const fragments: PackageContextFragment[] = [];
    const characterArtifacts = repositories.artifacts
      ? (await repositories.artifacts.listBySessionId(session.id)).filter((artifact) =>
          /character|persona/i.test(artifact.kind)
        )
      : [];
    const characterDocs = repositories.memoryDocuments
      ? (await repositories.memoryDocuments.listByScope(`session:${session.id}`)).filter((document) =>
          /character|persona|角色/i.test(document.title) ||
          /character|persona|角色/i.test(document.content)
        )
      : [];

    if (characterArtifacts.length > 0 || characterDocs.length > 0) {
      fragments.push({
        id: `character-state:${session.id}`,
        title: pickLocalizedText(input.locale, {
          "zh-CN": "角色状态",
          en: "Character state"
        }),
        content: [
          ...characterArtifacts.map((artifact) =>
            `${pickLocalizedText(input.locale, { "zh-CN": "角色资产", en: "Character artifact" })}: ${artifact.kind} -> ${artifact.uri}`
          ),
          ...characterDocs.slice(0, 2).map((document) => `## ${document.title}\n${truncate(document.content, 220)}`)
        ].join("\n\n"),
        priority: 76,
        channel: "state"
      });
    } else {
      fragments.push({
        id: `character-continuity:${session.id}`,
        title: pickLocalizedText(input.locale, {
          "zh-CN": "角色连续性",
          en: "Character continuity"
        }),
        content: pickLocalizedText(input.locale, {
          "zh-CN": [
            "如果本回合引入新的命名角色，请明确给出称呼、立场和可观察特征。",
            "已经出现过的角色必须保持称呼、关系、显著外观和当前状态连续，不要凭空改写。"
          ].join("\n"),
          en: [
            "If a new named character appears, make their name, stance, and observable traits explicit.",
            "For established characters, keep names, relationships, visible traits, and current state consistent across turns."
          ].join("\n")
        }),
        priority: 64,
        channel: "state"
      });
    }

    return fragments;
  }
};

export default contextProvider;

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength).trimEnd()}…`
    : value;
}
